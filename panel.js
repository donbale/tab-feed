// panel.js — Dynamic Front Page + Summarizer + Prompt classification

const counts = document.getElementById("counts");
const elHero  = document.getElementById("region-hero");
const elLeads = document.getElementById("region-leads");
const elMain  = document.getElementById("region-main");
const elRail  = document.getElementById("region-rail");
const listGrid= document.getElementById("grid"); // fallback holder (kept hidden)
const nav     = document.getElementById("filters");

// ---------- utils ----------
function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function mdToText(md = "") {
  return md
    .replace(/^###?\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}
function score(it) {
  // recency + summary + pinned
  const recencyMin = (Date.now() - (it.updatedAt || 0)) / 60000;
  let s = 1000 - Math.min(recencyMin, 1000);
  if (it.summary && it.summary.length) s += 200;
  if (it.pinned) s += 150;
  return s;
}

// ---------- Summarizer ----------
let summarizerInst = null;
async function getSummarizer() {
  try {
    const API = globalThis.Summarizer || (globalThis.ai && globalThis.ai.summarizer);
    if (!API) return null;
    const caps = API.capabilities ? await API.capabilities() : await API.availability?.();
    if (!caps || caps.available === "no") return null;
    if (!summarizerInst) {
      summarizerInst = await API.create({
        type: "key-points",
        length: "short",
        format: "markdown",
        output: { language: "en" }
      });
    }
    return summarizerInst;
  } catch { return null; }
}
async function summarizeMD(text) {
  const inst = await getSummarizer();
  if (!inst) return null;
  try {
    const out = await inst.summarize((text || "").slice(0, 4000), {
      format: "markdown",
      output: { language: "en" }
    });
    return typeof out === "string" ? out : (out?.summary || "");
  } catch { return null; }
}

// ---------- Prompt API classification ----------
async function getLM() {
  try {
    const LM = globalThis.LanguageModel || (globalThis.ai && globalThis.ai.languageModel);
    if (!LM) return null;
    const session = await LM.create?.({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    });
    return session || null;
  } catch { return null; }
}
const CATEGORY_ENUM = [
  "News","Technology","Developer Docs","Research","Video","Social",
  "Shopping","Entertainment","Finance","Sports","Productivity","Other"
];
async function classifyTabContent(fullText, url, title, description) {
  const lm = await getLM();
  if (!lm) return null;
  const domain = (() => { try { return new URL(url).hostname.replace(/^www\./,""); } catch { return ""; }})();
  const text = (fullText || description || title || "").slice(0, 1000);

  const systemPrompt = `You are a browser tab classifier.
Choose up to 3 categories from: ${CATEGORY_ENUM.join(", ")}.
Return ONLY a JSON array of strings, e.g. ["News","Technology"].`;
  const userPrompt = `Domain: ${domain}\nTitle: ${title || ""}\nDescription: ${description || ""}\nText: """${text}"""`;

  try {
    const res = await lm.prompt([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);
    let parsed; try { parsed = JSON.parse(res); } catch {}
    if (!Array.isArray(parsed)) parsed = ["Other"];
    const clean = parsed.map(s => String(s).trim()).filter(s => CATEGORY_ENUM.includes(s)).slice(0,3);
    return { categories: clean.length ? clean : ["Other"] };
  } catch (e) {
    console.warn("[TabFeed][panel] classify failed:", e);
    return null;
  }
}

// ---------- queues ----------
let summaryQueue = [];
let summaryRunning = false;
async function runSummaryQueue() {
  if (summaryRunning) return;
  summaryRunning = true;
  while (summaryQueue.length) {
    const it = summaryQueue.shift();
    const md = await summarizeMD(it.fullText);
    if (md) {
      chrome.runtime.sendMessage({
        type: "TAB_SUMMARY_FROM_PANEL",
        tabId: it.tabId,
        summary: md
      }).catch(() => {});
    }
  }
  summaryRunning = false;
}

let classifyQueue = [];
let classifyRunning = false;
async function runClassifyQueue() {
  if (classifyRunning) return;
  classifyRunning = true;
  while (classifyQueue.length) {
    const it = classifyQueue.shift();
    if (!(it.fullText && it.fullText.length >= 120)) continue;
    if (Array.isArray(it.categories) && it.categories.length) continue; // already have
    const result = await classifyTabContent(it.fullText, it.url, it.title, it.description);
    if (result && result.categories) {
      chrome.runtime.sendMessage({
        type: "TAB_CLASSIFICATION_FROM_PANEL",
        tabId: it.tabId,
        categories: result.categories
      }).catch(() => {});
    }
  }
  classifyRunning = false;
}

// ---------- category filter ----------
let activeFilter = null;
function renderFilters(items) {
  // Build category counts from current items
  const countsMap = new Map();
  for (const it of items) {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    for (const c of cats) countsMap.set(c, (countsMap.get(c) || 0) + 1);
  }
  nav.innerHTML = "";
  if (!countsMap.size) return; // hide until we have at least one category

  const makeBtn = (label, on, handler) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (on) b.classList.add("active");
    b.onclick = handler;
    return b;
  };
  nav.appendChild(makeBtn(activeFilter ? "All" : "All ✓", !activeFilter, () => { activeFilter = null; hydrate(); }));
  const preferredOrder = CATEGORY_ENUM.filter(c => countsMap.has(c));
  for (const c of preferredOrder) {
    nav.appendChild(
      makeBtn(activeFilter === c ? `${c} ✓` : c, activeFilter === c, () => { activeFilter = (activeFilter === c ? null : c); hydrate(); })
    );
  }
}

// ---------- card builders ----------
function actionsBar(it) {
  const actions = document.createElement("div");
  actions.className = "actions";
  const btn = (txt, handler) => {
    const b = document.createElement("button");
    b.textContent = txt;
    b.onclick = (e) => { e.stopPropagation(); handler(); };
    return b;
  };
  const link = document.createElement("a");
  link.href = it.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "Open link";
  link.onclick = (e) => e.stopPropagation();

  actions.appendChild(btn("Focus", () => chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId })));
  actions.appendChild(btn(it.pinned ? "Unpin" : "Pin", () => chrome.runtime.sendMessage({ type: "PIN_TOGGLE", tabId: it.tabId })));
  actions.appendChild(btn("Close", () => chrome.runtime.sendMessage({ type: "CLOSE_TAB", tabId: it.tabId })));
  actions.appendChild(link);
  return actions;
}
function chipBar(cats=[]) {
  if (!cats.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "chips";
  for (const c of cats) {
    const x = document.createElement("span");
    x.className = "chip"; x.textContent = c; wrap.appendChild(x);
  }
  return wrap;
}
function card(it, { variant="standard" } = {}) {
  const el = document.createElement("article");
  el.className = "card" + (variant==="hero" ? " hero" : "");
  el.onclick = () => chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId });

  const img = document.createElement("img");
  img.className = "thumb" + (variant==="hero" ? " hero" : "");
  img.src = it.heroImage || it.favicon || "";
  img.alt = ""; img.referrerPolicy = "no-referrer";
  el.appendChild(img);

  const h = document.createElement("h2");
  h.textContent = it.title || it.url;
  el.appendChild(h);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${it.domain || ""} • ${timeAgo(it.updatedAt)}`;
  el.appendChild(meta);

  const cats = Array.isArray(it.categories) ? it.categories : [];
  const chips = chipBar(cats);
  if (chips) el.appendChild(chips);

  const sum = document.createElement("div");
  sum.className = "summary";
  if (it.summary) sum.textContent = mdToText(it.summary);
  else if (it.fullText && it.fullText.length >= 120) { sum.textContent = "Generating TL;DR…"; summaryQueue.push(it); }
  else if (it.fullText) sum.textContent = "Not enough text yet…";
  else sum.textContent = "No article text extracted yet.";
  el.appendChild(sum);

  el.appendChild(actionsBar(it));
  return el;
}

// ---------- front-page render ----------
function renderFront(items) {
  // Apply active category if any
  const source = activeFilter ? items.filter(it => (it.categories || []).includes(activeFilter)) : items;
  counts.textContent = `${source.length} open tab${source.length === 1 ? "" : "s"}`;

  // Sort by prominence
  const sorted = [...source].sort((a,b) => score(b)-score(a));

  // Regions
  const hero = sorted.find(x => x.heroImage || x.summary) || sorted[0];
  const rest = sorted.filter(x => x !== hero);
  const leads = rest.slice(0, 3);
  const afterLeads = rest.slice(3);
  const main  = afterLeads.slice(0, 9);
  const rail  = afterLeads.slice(9, 17);

  elHero.innerHTML = elLeads.innerHTML = elMain.innerHTML = elRail.innerHTML = "";
  if (hero) elHero.appendChild(card(hero, { variant:"hero" }));
  for (const it of leads) elLeads.appendChild(card(it));
  for (const it of main)  elMain.appendChild(card(it));
  for (const it of rail)  elRail.appendChild(card(it));

  // Queue jobs
  // Aggressively classify anything with text but no categories yet
  for (const it of source) {
    if ((!Array.isArray(it.categories) || it.categories.length === 0) &&
        it.fullText && it.fullText.length >= 120) {
      classifyQueue.push(it);
    }
    if (it.fullText && it.fullText.length >= 120 && !it.summary) {
      summaryQueue.push(it);
    }
  }
  runClassifyQueue();
  runSummaryQueue();
}

// ---------- hydrate ----------
function render(items) {
  // filters appear once any category exists
  const anyCats = items.some(it => Array.isArray(it.categories) && it.categories.length);
  nav.innerHTML = ""; if (anyCats) renderFilters(items);

  // always use front-page layout
  listGrid.hidden = true;
  renderFront(items);
}
async function fetchTabsFromSW() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TABS_NOW" }, (res) => {
      if (res && res.ok && Array.isArray(res.tabs)) resolve(res.tabs);
      else resolve(null);
    });
  });
}
async function hydrate() {
  const sw = await fetchTabsFromSW();
  if (sw) { render(sw); return; }
  const { tabs = [] } = await chrome.storage.local.get("tabs");
  render(Array.isArray(tabs) ? tabs : []);
}

// live updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TABS_UPDATED") hydrate();
});
chrome.runtime.sendMessage({ type: "PANEL_OPENED" }).catch(() => {});
hydrate();

// ---------- Optional: “Classify all” button support ----------
document.getElementById("classifyAll")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const { tabs = [] } = await chrome.storage.local.get("tabs");
  for (const it of tabs) {
    if (it.fullText && it.fullText.length >= 120 && (!it.categories || !it.categories.length)) {
      classifyQueue.push(it);
    }
  }
  runClassifyQueue();
});

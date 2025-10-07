// panel.js — Front Page + Summarizer + Prompt classification + Entities + Reading-time badges

const counts = document.getElementById("counts");
const elHero  = document.getElementById("region-hero");
const elLeads = document.getElementById("region-leads");
const elMain  = document.getElementById("region-main");
const elRail  = document.getElementById("region-rail");
const listGrid= document.getElementById("grid"); // optional / hidden
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
  const recencyMin = (Date.now() - (it.updatedAt || 0)) / 60000;
  let s = 1000 - Math.min(recencyMin, 1000);
  if (it.summary && it.summary.length) s += 200;
  if (it.pinned) s += 150;
  return s;
}
function estimateReadingMinutes(text = "") {
  const words = (text.match(/\b\w+\b/g) || []).length;
  return Math.max(1, Math.round(words / 220)); // ~220 wpm
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

// ---------- Prompt API (LanguageModel) ----------
async function getLM() {
  try {
    const LM = globalThis.LanguageModel || (globalThis.ai && globalThis.ai.languageModel);
    if (!LM) return null;
    const session = await LM.create?.({
      expectedInputs:  [{ type: "text", languages: ["en"] }],
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
  const userPrompt = `Domain: ${domain}
Title: ${title || ""}
Description: ${description || ""}
Text: """${text}"""`;

  try {
    const res = await lm.prompt([{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]);
    let parsed; try { parsed = JSON.parse(res); } catch {}
    if (!Array.isArray(parsed)) parsed = ["Other"];
    const clean = parsed.map(s => String(s).trim()).filter(s => CATEGORY_ENUM.includes(s)).slice(0,3);
    return { categories: clean.length ? clean : ["Other"] };
  } catch (e) {
    console.warn("[TabFeed][panel] classify failed:", e);
    return null;
  }
}

// ---------- Entities (Prompt API) ----------
async function extractEntities(fullText, url, title, description) {
  const lm = await getLM();
  if (!lm) return null;

  const snippet = (fullText || description || title || "").slice(0, 1200);
  const system = `Extract named entities from a news/article snippet.
Return STRICT JSON: {"people":[...], "orgs":[...], "places":[...]}
- Each list: 0-6 short strings
- No commentary. JSON only.`;
  const user = `Title: ${title || ""}
URL: ${url || ""}
Text: """${snippet}"""`;

  try {
    const out = await lm.prompt([{ role: "system", content: system }, { role: "user", content: user }]);
    let obj; try { obj = JSON.parse(out); } catch {}
    if (!obj) return null;
    const norm = (arr) => (Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(Boolean).slice(0,6) : []);
    return { people: norm(obj.people), orgs: norm(obj.orgs), places: norm(obj.places) };
  } catch (e) {
    console.warn("[TabFeed][panel] entities failed:", e);
    return null;
  }
}

// ---------- queues ----------
const lastSummarizedSig = new Map(); // tabId -> sig

let summaryQueue = [];
let summaryRunning = false;
async function runSummaryQueue() {
  if (summaryRunning) return;
  summaryRunning = true;
  while (summaryQueue.length) {
    const it = summaryQueue.shift();
    const md = await summarizeMD(it.fullText);
    if (md) {
      chrome.runtime.sendMessage({ type: "TAB_SUMMARY_FROM_PANEL", tabId: it.tabId, summary: md }).catch(() => {});
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
    if (Array.isArray(it.categories) && it.categories.length) continue;
    const result = await classifyTabContent(it.fullText, it.url, it.title, it.description);
    if (result && result.categories) {
      chrome.runtime.sendMessage({ type: "TAB_CLASSIFICATION_FROM_PANEL", tabId: it.tabId, categories: result.categories }).catch(() => {});
    }
  }
  classifyRunning = false;
}

let entitiesQueue = [];
let entitiesRunning = false;
async function runEntitiesQueue() {
  if (entitiesRunning) return;
  entitiesRunning = true;
  while (entitiesQueue.length) {
    const it = entitiesQueue.shift();
    if (!(it.fullText && it.fullText.length >= 120)) continue;
    if (it.entities && (it.entities.people?.length || it.entities.orgs?.length || it.entities.places?.length)) continue;
    const ents = await extractEntities(it.fullText, it.url, it.title, it.description);
    if (ents) {
      chrome.runtime.sendMessage({ type: "TAB_ENTITIES_FROM_PANEL", tabId: it.tabId, entities: ents }).catch(() => {});
    }
  }
  entitiesRunning = false;
}

// ---------- category filter ----------
let activeFilter = null;
function renderFilters(items) {
  const countsMap = new Map();
  for (const it of items) {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    for (const c of cats) countsMap.set(c, (countsMap.get(c) || 0) + 1);
  }
  nav.innerHTML = "";
  if (!countsMap.size) return;

  const makeBtn = (label, on, handler) => {
    const b = document.createElement("button");
    b.textContent = label; if (on) b.classList.add("active"); b.onclick = handler; return b;
  };
  nav.appendChild(makeBtn(activeFilter ? "All" : "All ✓", !activeFilter, () => { activeFilter = null; hydrate(); }));

  const preferredOrder = CATEGORY_ENUM.filter(c => countsMap.has(c));
  for (const c of preferredOrder) {
    nav.appendChild(makeBtn(activeFilter === c ? `${c} ✓` : c, activeFilter === c,
      () => { activeFilter = (activeFilter === c ? null : c); hydrate(); }));
  }
}

// ---------- UI helpers ----------
function chipBar(cats=[]) {
  if (!cats.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "chips";
  for (const c of cats) { const x = document.createElement("span"); x.className = "chip"; x.textContent = c; wrap.appendChild(x); }
  return wrap;
}
function entitiesBar(entities) {
  const { people=[], orgs=[], places=[] } = entities || {};
  if (![...people, ...orgs, ...places].length) return null;
  const wrap = document.createElement("div");
  wrap.className = "chips";
  const add = (label) => { const s = document.createElement("span"); s.className="chip"; s.textContent=label; wrap.appendChild(s); };
  people.forEach(p => add(p));
  orgs.forEach(o => add(o));
  places.forEach(pl => add(pl));
  return wrap;
}
function badgesRow(it) {
  const row = document.createElement("div");
  row.className = "chips";
  // Estimated reading time
  const rt = document.createElement("span");
  rt.className = "chip";
  const minutes = (typeof it.readingMinutes === "number")
    ? it.readingMinutes
    : (it.fullText ? estimateReadingMinutes(it.fullText) : null);
  if (minutes != null) rt.textContent = `~${minutes} min`; else rt.textContent = "~— min";
  row.appendChild(rt);

  // Tab age (since firstSeen)
  const age = document.createElement("span");
  age.className = "chip";
  const first = it.firstSeen || it.updatedAt || Date.now();
  age.textContent = `opened ${timeAgo(first)}`;
  row.appendChild(age);

  // if we computed locally but not saved yet, persist
  if (it.tabId && it.fullText && it.readingMinutes == null && minutes != null) {
    chrome.runtime.sendMessage({ type: "TAB_READINGTIME_FROM_PANEL", tabId: it.tabId, minutes }).catch(()=>{});
  }

  return row;
}

// ---------- card builders ----------
function actionsBar(it) {
  const actions = document.createElement("div");
  actions.className = "actions";
  const btn = (txt, handler) => { const b = document.createElement("button"); b.textContent = txt; b.onclick = (e)=>{ e.stopPropagation(); handler(); }; return b; };
  const link = document.createElement("a");
  link.href = it.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "Open link"; link.onclick = (e)=> e.stopPropagation();

  actions.appendChild(btn("Focus", () => chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId })));
  actions.appendChild(btn(it.pinned ? "Unpin" : "Pin", () => chrome.runtime.sendMessage({ type: "PIN_TOGGLE", tabId: it.tabId })));
  actions.appendChild(btn("Close", () => chrome.runtime.sendMessage({ type: "CLOSE_TAB", tabId: it.tabId })));
  actions.appendChild(link);

  return actions;
}

function card(it, { variant="standard" } = {}) {
  const el = document.createElement("article");
  el.dataset.tab = it.tabId;
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

  const cats = chipBar(it.categories || []);
  if (cats) el.appendChild(cats);

  // Badges: reading time + tab age
  el.appendChild(badgesRow(it));

  // Entities chips (if we have them)
  const ents = entitiesBar(it.entities);
  if (ents) el.appendChild(ents);

  // Summary (with content-signature requeue)
  const sum = document.createElement("div");
  sum.className = "summary";
  const sig = [(it.url || ""), (it.title || ""), (it.fullText ? it.fullText.length : 0)].join("|");
  const prevSig = lastSummarizedSig.get(it.tabId);

  if (prevSig && prevSig !== sig) {
    // background should have invalidated summary; show pending
  }

  if (it.summary) {
    sum.textContent = mdToText(it.summary);
    lastSummarizedSig.set(it.tabId, sig);
  } else if (it.fullText && it.fullText.length >= 120) {
    sum.textContent = "Generating TL;DR…";
    if (prevSig !== sig) {
      summaryQueue.push(it);
      lastSummarizedSig.set(it.tabId, sig);
    }
  } else if (it.fullText) {
    sum.textContent = "Not enough text yet…";
  } else {
    sum.textContent = "No article text extracted yet.";
  }
  el.appendChild(sum);

  el.appendChild(actionsBar(it));

  // Queue AI jobs if needed
  if ((!Array.isArray(it.categories) || it.categories.length === 0) &&
      it.fullText && it.fullText.length >= 120) {
    classifyQueue.push(it);
  }
  if (it.fullText && it.fullText.length >= 120 &&
      !(it.entities && (it.entities.people?.length || it.entities.orgs?.length || it.entities.places?.length))) {
    entitiesQueue.push(it);
  }

  return el;
}

// ---------- front-page render ----------
function renderFront(items) {
  const source = activeFilter ? items.filter(it => (it.categories || []).includes(activeFilter)) : items;
  counts.textContent = `${source.length} open tab${source.length === 1 ? "" : "s"}`;

  const sorted = [...source].sort((a,b) => score(b)-score(a));
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

  runClassifyQueue();
  runEntitiesQueue();
  runSummaryQueue();
}

// ---------- hydrate & filters ----------
function render(items) {
  const anyCats = items.some(it => Array.isArray(it.categories) && it.categories.length);
  nav.innerHTML = ""; if (anyCats) renderFilters(items);
  if (listGrid) listGrid.hidden = true;
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TABS_UPDATED") hydrate();
});
chrome.runtime.sendMessage({ type: "PANEL_OPENED" }).catch(() => {});
hydrate();

// Optional: “Classify all” if you added #classifyAll in HTML
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

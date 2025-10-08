// panel.js — Front Page + Summarizer + Prompt classification + Entities + Reading-time badges + Smart Bundles

const counts = document.getElementById("counts");
const elHero  = document.getElementById("region-hero");
const elLeads = document.getElementById("region-leads");
const elMain  = document.getElementById("region-main");
const elRail  = document.getElementById("region-rail");
const listGrid= document.getElementById("grid"); // optional / hidden
const nav     = document.getElementById("filters");

// --- Smart Bundles regions (new) ---
const elBundles = document.getElementById("bundles");
const elSuggestions = document.getElementById("suggestions");

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

// ---- Related Google search (for all tabs) ----
function buildRelatedQuery(it) {
  const parts = [];
  if (it?.title) parts.push(it.title);
  if (it?.summary) {
    const text = mdToText(it.summary).replace(/\s+/g, " ").trim();
    parts.push(text.split(" ").slice(0, 12).join(" "));
  }
  const seen = new Set();
  const uniq = [];
  for (const p of parts) {
    const t = (p || "").trim();
    if (t && !seen.has(t)) { seen.add(t); uniq.push(t); }
  }
  const q = uniq.join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
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
  const rt = document.createElement("span");
  rt.className = "chip";
  const minutes = (typeof it.readingMinutes === "number")
    ? it.readingMinutes
    : (it.fullText ? estimateReadingMinutes(it.fullText) : null);
  if (minutes != null) rt.textContent = `~${minutes} min`; else rt.textContent = "~— min";
  row.appendChild(rt);

  const age = document.createElement("span");
  age.className = "chip";
  const first = it.firstSeen || it.updatedAt || Date.now();
  age.textContent = `opened ${timeAgo(first)}`;
  row.appendChild(age);

  if (it.tabId && it.fullText && it.readingMinutes == null && minutes != null) {
    chrome.runtime.sendMessage({ type: "TAB_READINGTIME_FROM_PANEL", tabId: it.tabId, minutes }).catch(()=>{});
  }

  return row;
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
  link.href = it.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open link";
  link.onclick = (e) => e.stopPropagation();

  actions.appendChild(btn("Focus", () =>
    chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId })
  ));
  actions.appendChild(btn(it.pinned ? "Unpin" : "Pin", () =>
    chrome.runtime.sendMessage({ type: "PIN_TOGGLE", tabId: it.tabId })
  ));
  actions.appendChild(btn("Close", () =>
    chrome.runtime.sendMessage({ type: "CLOSE_TAB", tabId: it.tabId })
  ));

  actions.appendChild(btn("Related search", () => {
    const url = buildRelatedQuery(it);
    chrome.tabs.create({ url });
  }));

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

  el.appendChild(badgesRow(it));

  const ents = entitiesBar(it.entities);
  if (ents) el.appendChild(ents);

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

// ---------- Smart Bundles (NEW) ----------

// Tab cue text used for clustering
function tabCue(it) {
  const ents = it.entities || {};
  const e = [...(ents.people||[]), ...(ents.orgs||[]), ...(ents.places||[])].slice(0,6).join(", ");
  const host = it.domain || "";
  return `id:${it.tabId} title:${(it.title||"").slice(0,120)} domain:${host} ents:${e}`;
}

// Ask LM to propose up to 2 bundles (3+ tabs each)
async function suggestBundlesFromTabs(tabs) {
  const lm = await getLM();
  if (!lm) return [];
  const cues = tabs.map(tabCue).join("\n");
  const system = `Group related browser tabs into at most 2 thematic bundles.
Return strict JSON: [{"title":"...", "tabIds":[...]}]
Rules:
- title: short (2-5 words), descriptive (e.g., "Jurassic Coast trip", "Swansea planning", "TypeScript generics").
- tabIds: numeric ids from the cues.
- Only group if 3+ tabs clearly fit the theme.
- If no clear groups, return [].`;
  try {
    const out = await lm.prompt([
      { role:"system", content: system },
      { role:"user", content: cues }
    ]);
    let arr; try { arr = JSON.parse(out); } catch {}
    if (!Array.isArray(arr)) return [];
    return arr
      .map(b => ({ title: String(b.title||"").trim(), tabIds: (b.tabIds||[]).filter(n => Number.isFinite(n)) }))
      .filter(b => b.title && b.tabIds.length >= 3)
      .slice(0, 2);
  } catch { return []; }
}

// Render banner(s) offering bundle creation
function renderSuggestions(bundlesProposed, tabsById) {
  if (!elSuggestions) return;
  elSuggestions.innerHTML = "";
  if (!bundlesProposed || !bundlesProposed.length) return;

  for (const b of bundlesProposed) {
    const wrap = document.createElement("div");
    wrap.className = "banner";
    const names = b.tabIds.map(id => (tabsById.get(id)?.title || tabsById.get(id)?.domain || id)).slice(0,3);
    const title = document.createElement("div");
    title.innerHTML = `<strong>It looks like you're working on “${b.title}”.</strong>`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${b.tabIds.length} tabs match • e.g., ${names.join(" • ")}`;
    const mk = document.createElement("button");
    mk.textContent = "Create bundle";
    mk.onclick = async (e) => {
      e.stopPropagation();
      const res = await new Promise(r => chrome.runtime.sendMessage({ type: "BUNDLE_CREATE", title: b.title, tabIds: b.tabIds }, r));
      if (res?.ok) {
        hydrate(); // show it
        summarizeBundle(res.id); // kick cross-summary + tips
      }
    };
    wrap.appendChild(title);
    wrap.appendChild(meta);
    wrap.appendChild(mk);
    elSuggestions.appendChild(wrap);
  }
}

// Summarize+tips across tabs in a bundle
async function summarizeBundle(bundleId) {
  const snap = await new Promise(r => chrome.runtime.sendMessage({ type:"GET_TABS_NOW" }, r));
  const bundle = (snap?.bundles || []).find(b => b.id === bundleId);
  if (!bundle) return;
  const tabsById = new Map((snap?.tabs||[]).map(t => [t.tabId, t]));
  const items = bundle.tabIds.map(id => tabsById.get(id)).filter(Boolean);

  const joined = items.map(it => `# ${it.title}\n${(it.summary || it.description || (it.fullText||"").slice(0,600))}\n`).join("\n");
  const smz = await getSummarizer();
  let bundleSummary = "";
  if (smz) {
    try {
      const out = await smz.summarize(joined.slice(0, 8000), { format:"markdown", output:{ language:"en" } });
      bundleSummary = (typeof out === "string") ? out : (out?.summary || "");
    } catch {}
  }

  const lm = await getLM();
  let tips = [];
  if (lm) {
    const kindGuess = bundle.title.toLowerCase().match(/travel|trip|itinerary|visit|hotel|map|sights/) ? "travel" : "study";
    const sys = `Given a user bundle of browser tabs, suggest 3-6 next steps.
Return strict JSON array of short strings like:
- For travel: ["Map key sights", "Draft 2-day itinerary", "Check train times", "Find local weather"]
- For study: ["Skim overview article", "Make flashcards of key terms", "Collect primary sources"]
No commentary.`;
    const usr = `Bundle title: ${bundle.title}
Kind: ${kindGuess}
Material:
"""${joined.slice(0, 2000)}"""`;
    try {
      const out = await lm.prompt([{ role:"system", content: sys }, { role:"user", content: usr }]);
      let arr; try { arr = JSON.parse(out); } catch {}
      tips = Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(Boolean).slice(0,6) : [];
    } catch {}
  }

  chrome.runtime.sendMessage({
    type: "BUNDLE_UPDATE_CONTENT",
    id: bundleId,
    summary: bundleSummary,
    tips
  });
}

// Render bundles section
function renderBundles(bundles, tabsById) {
  if (!elBundles) return;
  elBundles.innerHTML = "";
  if (!bundles || !bundles.length) return;

  for (const b of bundles) {
    const box = document.createElement("article");
    box.className = "card bundle";
    const count = b.tabIds.length;
    const h = document.createElement("h2");
    h.textContent = `🗂️ ${b.title}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${count} tab${count===1?"":"s"} • created ${timeAgo(b.createdAt)}`;
    const sum = document.createElement("div");
    sum.className = "summary";
    sum.textContent = b.summary ? mdToText(b.summary) : "Generating bundle summary…";

    box.appendChild(h);
    box.appendChild(meta);
    box.appendChild(sum);

    if (Array.isArray(b.tips) && b.tips.length) {
      const tips = document.createElement("div");
      tips.className = "chips";
      for (const t of b.tips) {
        const c = document.createElement("span");
        c.className = "chip";
        c.textContent = t;
        tips.appendChild(c);
      }
      box.appendChild(tips);
    }

    const list = document.createElement("div");
    list.style.display = "grid";
    list.style.gridTemplateColumns = "1fr 1fr";
    list.style.gap = "6px";
    for (const id of b.tabIds.slice(0, 8)) {
      const it = tabsById.get(id);
      if (!it) continue;
      const a = document.createElement("a");
      a.className = "chip";
      a.textContent = (it.title || it.domain || id).slice(0, 48);
      a.href = it.url; a.target = "_blank"; a.rel = "noreferrer";
      list.appendChild(a);
    }
    box.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "actions";
    const btn = (txt, fn) => { const btt = document.createElement("button"); btt.textContent = txt; btt.onclick = (e)=>{ e.stopPropagation(); fn(); }; return btt; };
    actions.appendChild(btn("Re-summarize", () => summarizeBundle(b.id)));
    actions.appendChild(btn("Delete bundle", async () => {
      await new Promise(r => chrome.runtime.sendMessage({ type:"BUNDLE_DELETE", id:b.id }, r));
      hydrate();
    }));
    box.appendChild(actions);

    elBundles.appendChild(box);
  }
}

// ---------- hydrate & filters ----------
function render(items, bundlesData = []) {
  const anyCats = items.some(it => Array.isArray(it.categories) && it.categories.length);
  nav.innerHTML = ""; if (anyCats) renderFilters(items);
  if (listGrid) listGrid.hidden = true;
  renderFront(items);

  // Bundles section
  const tabsById = new Map(items.map(t => [t.tabId, t]));
  renderBundles(bundlesData, tabsById);

  // Suggest smart bundles (non-blocking)
  suggestBundlesFromTabs(items).then(proposals => {
    renderSuggestions(proposals, tabsById);
  }).catch(()=>{});
}

async function fetchTabsFromSW() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TABS_NOW" }, (res) => {
      if (res && res.ok && Array.isArray(res.tabs)) resolve(res);
      else resolve(null);
    });
  });
}
async function hydrate() {
  const sw = await fetchTabsFromSW();
  if (sw) {
    render(sw.tabs || [], sw.bundles || []);
    return;
  }
  const { tabs = [], bundles = [] } = await chrome.storage.local.get(["tabs","bundles"]);
  render(Array.isArray(tabs) ? tabs : [], Array.isArray(bundles) ? bundles : []);
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

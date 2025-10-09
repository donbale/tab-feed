// panel.js — Front Page + Reading-time badges

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

// ---- Related Google search (for News tabs) ----
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

const CATEGORY_ENUM = [
  "News","Technology","Developer Docs","Research","Video","Social",
  "Shopping","Entertainment","Finance","Sports","Productivity","Other"
];

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

  // Related search on every tab
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

  // Badges: reading time + tab age
  el.appendChild(badgesRow(it));

  // Entities chips (if we have them)
  const ents = entitiesBar(it.entities);
  if (ents) el.appendChild(ents);

  // Summary (with content-signature requeue)
  const sum = document.createElement("div");
  sum.className = "summary";

  if (it.summary) {
    sum.textContent = mdToText(it.summary);
  } else if (it.fullText && it.fullText.length >= 120) {
    sum.textContent = "Generating TL;DR…";
  } else if (it.fullText) {
    sum.textContent = "Not enough text yet…";
  } else {
    sum.textContent = "No article text extracted yet.";
  }
  el.appendChild(sum);

  el.appendChild(actionsBar(it));

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
      if (res && res.ok && Array.isArray(res.tabs)) {
        resolve(res.tabs);
      } else {
        resolve(null);
      }
    });
  });
}
async function hydrate() {
  const sw = await fetchTabsFromSW();
  if (sw) {
    render(sw);
    return;
  }
  const { tabs = [] } = await chrome.storage.local.get("tabs");
  render(Array.isArray(tabs) ? tabs : []);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TABS_UPDATED") hydrate();
});
chrome.runtime.sendMessage({ type: "PANEL_OPENED" }).catch(() => {});
hydrate();

let latestPrivacy = {};
// ---- escapeHTML guard ----
if (typeof escapeHTML === "undefined") {
  function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/[&<>'"]/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[c]));
  }
}


// ---- Cross-file constants (guard) ----
if (typeof STATS === "undefined") {
  var STATS = { UPDATED: "STATS_UPDATED", CLEAN_NOW: "STATS_CLEAN_NOW" };
}

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
function renderFilters(items, bundles = []) {
  const countsMap = new Map();
  for (const it of items) {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    for (const c of cats) countsMap.set(c, (countsMap.get(c) || 0) + 1);
  }
  nav.innerHTML = "";

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

  if (bundles.length) {
    const separator = document.createElement("span");
    separator.className = "separator";
    nav.appendChild(separator);
  }

  for (const bundle of bundles) {
    const btn = document.createElement("a");
    btn.className = "tf-nav-btn"; // new class for styling
    btn.textContent = `🗂️ ${bundle.title}`;
    btn.href = `bundle.html?id=${bundle.id}`;
    nav.appendChild(btn);
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

  
  // Privacy chips (from latestPrivacy)
  const pf = latestPrivacy && latestPrivacy[it.tabId];
  if (pf) {
    const pv = document.createElement("div");
    pv.className = "chips";
    const mk = (label, value, warn=false) => {
      const sp = document.createElement("span");
      sp.className = "chip" + (warn ? " warn" : "");
      sp.textContent = `${label}: ${value}`;
      return sp;
    };
    pv.appendChild(mk("Trackers", pf.trackers||0, (pf.trackers||0)>0));
    pv.appendChild(mk("3rd‑party", pf.thirdParty||0));
    pv.appendChild(mk("Mixed", pf.mixedContent ? "yes" : "no", !!pf.mixedContent));
    pv.appendChild(mk("Mic", pf.micAllowed ? "on" : "off", !!pf.micAllowed));
    pv.appendChild(mk("Cam", pf.camAllowed ? "on" : "off", !!pf.camAllowed));
    el.appendChild(pv);
  }
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
  const main  = afterLeads.slice(0, 17);
  // Keep the rail dedicated to session stats; do not place tab cards there.

  // Clear content in hero, leads, and main — but leave the rail intact
  elHero.innerHTML = elLeads.innerHTML = elMain.innerHTML = "";
  if (hero) elHero.appendChild(card(hero, { variant:"hero" }));
  for (const it of leads) elLeads.appendChild(card(it));
  for (const it of main)  elMain.appendChild(card(it));
}

function renderSuggestions(suggestedBundles = [], tabsById) {
  const el = document.getElementById("suggestions");
  if (!el) return;
  el.innerHTML = "";
  if (!suggestedBundles.length) return;

  for (const bundle of suggestedBundles) {
    const banner = document.createElement("div");
    banner.className = "banner";
    const title = document.createElement("div");
    title.innerHTML = `<strong>It looks like you're working on “${bundle.title}”.</strong>`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const names = bundle.tabIds.map(id => (tabsById.get(id)?.title || "Untitled")).join(" • ");
    meta.textContent = `${bundle.tabIds.length} tabs match • e.g., ${names}`;
    const button = document.createElement("button");
    button.textContent = "Create bundle";
    button.onclick = () => {
      chrome.runtime.sendMessage({ type: "CREATE_BUNDLE", ...bundle });
      el.innerHTML = ""; // Hide suggestions after creating a bundle
    };
    banner.appendChild(title);
    banner.appendChild(meta);
    banner.appendChild(button);
    el.appendChild(banner);
  }
}



function render(items, suggestedBundles = [], bundles = []) {
  const anyCats = items.some(it => Array.isArray(it.categories) && it.categories.length);
  renderFilters(items, bundles);
  if (listGrid) listGrid.hidden = true;
  renderFront(items);
  renderSuggestions(suggestedBundles, new Map(items.map(t => [t.tabId, t])));
}

async function fetchTabsFromSW() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TABS_NOW" }, (res) => {
      if (res && res.ok) {
        resolve(res);
      } else {
        resolve(null);
      }
    });
  });
}
async function hydrate() {
  const sw = await fetchTabsFromSW();
  if (sw) {
    render(sw.tabs || [], sw.suggestedBundles || [], sw.bundles || []);
    return;
  }
  const { tabs = [], suggestedBundles = [], bundles = [] } = await chrome.storage.local.get(["tabs", "suggestedBundles", "bundles"]);
  render(Array.isArray(tabs) ? tabs : [], Array.isArray(suggestedBundles) ? suggestedBundles : [], Array.isArray(bundles) ? bundles : []);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TABS_UPDATED") hydrate();
});
chrome.runtime.sendMessage({ type: "PANEL_OPENED" }).catch(() => {});
hydrate();

// ===== Rail: Session Stats, Quick Chips, Context Score, Privacy =====

function renderRail(stats, privacy){
  if (!elRail) return;
  const cleanAgo = stats.timeSinceLastCleanMs != null ? timeAgo(Date.now() - stats.timeSinceLastCleanMs) : "never";
  const hotList = (stats.hot||[]).map(h => `
    <li class="hot-item">
      <span class="title">${escapeHTML(h.title||'Tab')}</span>
      <span class="badge">${h.count1m}/min</span>
    </li>`).join("");

  const domains = (stats.domainsTop||[]).map(([host,count]) => `
    <li class="domain-item"><span>${host}</span><span class="badge">${count}</span></li>`).join("");

  // Context nudge
  const ctx = stats.contextScore ?? 100;
  const nudge = ctx < 40 ? "Your tabs look scattered — consider grouping or closing a few outliers." :
                ctx < 70 ? "A bit of a mix — grouping related work could help focus." :
                           "Nice! Your current tabs are fairly cohesive.";

  // Category chips
  const chips = Object.entries(stats.categories||{}).map(([k,v]) => `
    <button class="chip" data-chip="${k}">${k} <span class="badge">${v}</span></button>`).join("");

  elRail.innerHTML = `
    <section class="rail-card">
      <h3>Session Stats</h3>
      <ul class="kv">
        <li><span>Open tabs</span><span>${stats.openTabs}</span></li>
        <li><span>Unique domains</span><span>${stats.uniqueDomains}</span></li>
        <li><span>Memory usage</span><span>${stats.memoryEstimateMB} MB</span></li>
      
      </ul>
      
    </section>


    <section class="rail-card">
      <h3>Security &amp; Safety</h3>
      <ul class="kv">
        <li><span>Insecure tabs (HTTP)</span><span><span class="badge">${stats.insecureTabs||0}</span></span></li>
        <li><span>Tabs w/ trackers</span><span><span class="badge">${stats.tabsWithTrackers||0}</span></span></li>
        <li><span>Potentially risky domains</span><span><span class="badge">${stats.riskyDomainsCount||0}</span></span></li>
      </ul>
      ${ (stats.riskyDomains && stats.riskyDomains.length) ? `<details><summary class="subtle">Show domains</summary><ol class="list domainlist">${stats.riskyDomains.map(h=>`<li class='domain-item'><span>${h}</span></li>`).join("")}</ol></details>` : "" }
    </section>


    <section class="rail-card">
      <h3>Top Domains</h3>
      <ol class="list">${domains || "<li>No data</li>"}</ol>
    </section>

    <section class="rail-card">
      <h3>Quick Chips</h3>
      <div class="chips">${chips}</div>
    </section>

    <section class="rail-card">
      <h3>Focus — Context score <span class="badge">${ctx}</span></h3>
      <p class="subtle">${nudge}</p>
      <ol class="list hotlist">${hotList || "<li class='domain-item'>No hot tabs</li>"}</ol>
    </section>
  `;

  document.getElementById("btn-clean")?.addEventListener("click", ()=>{
    chrome.runtime.sendMessage({type: STATS.CLEAN_NOW}, (res)=>{ /* refreshed by bg */ });
  });

  // chip filters
  elRail.querySelectorAll(".chip").forEach(ch=>{
    ch.addEventListener("click", ()=>{
      const which = ch.dataset.chip;
      // simple broadcast: filter main grid by category using existing list if present
      // You can hook into your existing filters if available.
      alert("Filter by " + which + " — hook into your list rendering to apply.");
    });
  });
}

// Listen for stat updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === STATS.UPDATED) {
    // stats include contextScore; ensure default
    msg.stats.contextScore = msg.stats.contextScore ?? 100;
    latestPrivacy = msg.privacy || {};
    renderRail(msg.stats, {});
  }
});

// initial ping to get stats
chrome.runtime.sendMessage({type: "PANEL_PING"});

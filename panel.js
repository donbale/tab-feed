// panel.js — UI + Summarizer API (panel-only), reads from chrome.storage.local

const grid = document.getElementById("grid");
const counts = document.getElementById("counts");

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

// ---------- Summarizer (panel context) ----------
let summarizerInst = null;
async function getSummarizer() {
  try {
    const API = globalThis.Summarizer || (globalThis.ai && globalThis.ai.summarizer);
    if (!API) return null;
    const caps = API.capabilities ? await API.capabilities() : await API.availability?.();
    if (!caps || caps.available === "no") return null;
    if (!summarizerInst) {
      const lang = (navigator.language || "en").slice(0, 2);
      summarizerInst = await API.create({
        type: "key-points",
        length: "short",
        output: { language: lang }
      });
    }
    return summarizerInst;
  } catch {
    return null;
  }
}

async function summarizeMD(text) {
  const inst = await getSummarizer();
  if (!inst) return null;
  const lang = (navigator.language || "en").slice(0, 2);
  try {
    const out = await inst.summarize((text || "").slice(0, 4000), {
      format: "markdown",
      output: { language: lang }
    });
    return typeof out === "string" ? out : (out?.summary || "");
  } catch {
    return null;
  }
}

// Queue to avoid spamming the model
let summaryQueue = [];
let queueRunning = false;
async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
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
  queueRunning = false;
}

// ---------- rendering ----------
function render(items) {
  counts.textContent = `${items.length} open tab${items.length === 1 ? "" : "s"}`;
  grid.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("article");
    card.className = "card";
    card.addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId })
    );

    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = it.heroImage || it.favicon || "";
    img.addEventListener("click", (e) => { e.stopPropagation(); img.classList.toggle("expanded"); });
    card.appendChild(img);

    const h = document.createElement("h2");
    h.textContent = it.title || it.url;
    card.appendChild(h);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.domain || ""} • ${timeAgo(it.updatedAt)}`;
    card.appendChild(meta);

    const p = document.createElement("p");
    p.textContent = it.description || "";
    card.appendChild(p);

    const sum = document.createElement("div");
    sum.className = "summary";
    if (it.summary) {
      sum.textContent = mdToText(it.summary);
    } else if (it.fullText && it.fullText.length >= 120) {
      sum.textContent = "Generating TL;DR…";
      summaryQueue.push(it); // let panel summarize
    } else if (it.fullText) {
      sum.textContent = "Not enough text yet…";
    } else {
      sum.textContent = "No article text extracted yet.";
    }
    card.appendChild(sum);

    const actions = document.createElement("div");
    actions.className = "actions";

    const focusBtn = document.createElement("button");
    focusBtn.textContent = "Focus";
    focusBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId });
    };
    actions.appendChild(focusBtn);

    const pinBtn = document.createElement("button");
    pinBtn.textContent = it.pinned ? "Unpin" : "Pin";
    pinBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "PIN_TOGGLE", tabId: it.tabId });
    };
    actions.appendChild(pinBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "CLOSE_TAB", tabId: it.tabId });
    };
    actions.appendChild(closeBtn);

    const visit = document.createElement("a");
    visit.href = it.url; visit.target = "_blank"; visit.rel = "noreferrer";
    visit.textContent = "Open link";
    visit.addEventListener("click", (e) => e.stopPropagation());
    actions.appendChild(visit);

    card.appendChild(actions);
    grid.appendChild(card);
  }
  runQueue(); // kick after drawing
}

// ---------- hydrate ----------
async function fetchTabsFromSW() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TABS_NOW" }, (res) => {
      if (res && res.ok && Array.isArray(res.tabs)) resolve(res.tabs);
      else resolve(null);
    });
  });
}

async function hydrate() {
  // Prefer SW snapshot
  const fromSW = await fetchTabsFromSW();
  if (fromSW) {
    render(fromSW);
    return;
  }
  // Fallback: read from persistent storage
  const { tabs = [] } = await chrome.storage.local.get("tabs");
  render(Array.isArray(tabs) ? tabs : []);
}

// Live updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TABS_UPDATED") hydrate();
});

// On open: tell SW and hydrate
chrome.runtime.sendMessage({ type: "PANEL_OPENED" }).catch(() => {});
hydrate();

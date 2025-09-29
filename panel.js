// panel.js — render-only UI + “summarize on panel focus/open”

const grid = document.getElementById("grid");
const counts = document.getElementById("counts");

// ---------- time & text helpers ----------
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function markdownToText(md) {
  if (!md) return "";
  return md
    .replace(/^\s*[-*]\s+/gm, "• ") // bullets
    .replace(/[`*_#>]/g, "")        // lightweight strip
    .trim();
}

function isErrorSummary(s) {
  return typeof s === "string" && s.startsWith("[TL;DR error:");
}

// ---------- ask active tabs to summarize when needed ----------
async function triggerSummariesForMissing() {
  const { tabs = [] } = await chrome.storage.session.get("tabs");
  const targets = tabs.filter(t => !t.summary && t.fullText && t.fullText.length >= 120);
  for (const t of targets) {
    try {
      await chrome.tabs.sendMessage(t.tabId, { type: "REQUEST_SUMMARY" });
    } catch {
      // Tab might be discarded or site access isn’t granted; ignore
    }
  }
}

// ---------- rendering ----------
function render(items) {
  counts.textContent = `${items.length} open tab${items.length === 1 ? "" : "s"}`;
  grid.innerHTML = "";

  for (const it of items) {
    const card = document.createElement("article");
    card.className = "card";

    // Focus tab when clicking anywhere on the card (except on explicit controls)
    card.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId });
    });

    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = it.heroImage || it.favicon || "";
    // Toggle expand/collapse on image click
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      img.classList.toggle("expanded");
    });
    card.appendChild(img);

    const h = document.createElement("h2");
    h.textContent = it.title || it.url;
    card.appendChild(h);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.domain} • ${timeAgo(it.updatedAt)}`;
    card.appendChild(meta);

    const p = document.createElement("p");
    p.textContent = it.description || "";
    card.appendChild(p);

    // Summary area
    const sumWrap = document.createElement("div");
    sumWrap.className = "summary";
    if (it.summary) {
      // If the first attempt failed we show that, but a later successful summary will overwrite it
      if (isErrorSummary(it.summary)) {
        sumWrap.textContent = "⚠️ " + it.summary;
      } else {
        sumWrap.textContent = markdownToText(it.summary);
      }
    } else if (it.fullText && it.fullText.length >= 120) {
      sumWrap.textContent = "Generating TL;DR…";
    } else if (it.fullText && it.fullText.length > 0) {
      sumWrap.textContent = "Not enough text yet…";
    } else {
      sumWrap.textContent = "No article text extracted yet.";
    }
    card.appendChild(sumWrap);

    // Actions
    const actions = document.createElement("div");
    actions.className = "actions";

    const openBtn = document.createElement("button");
    openBtn.textContent = "Focus";
    openBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId });
    };
    actions.appendChild(openBtn);

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
    visit.href = it.url;
    visit.target = "_blank";
    visit.rel = "noreferrer";
    visit.textContent = "Open link";
    // prevent card click when clicking the anchor
    visit.addEventListener("click", (e) => e.stopPropagation());
    actions.appendChild(visit);

    card.appendChild(actions);
    grid.appendChild(card);
  }
}

// ---------- state wiring ----------
async function hydrate() {
  const { tabs = [] } = await chrome.storage.session.get("tabs");
  render(tabs);
}

// Re-render when background updates the tab list
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TABS_UPDATED") {
    const y = window.scrollY;
    hydrate().then(() => window.scrollTo({ top: y, left: 0, behavior: "instant" }));
  }
});

// When the panel is shown/focused, try to fill any missing summaries
window.addEventListener("focus", () => {
  triggerSummariesForMissing();
  hydrate();
});

// Initial load
(async () => {
  await hydrate();
  triggerSummariesForMissing();
})();

const grid = document.getElementById("grid");
const counts = document.getElementById("counts");

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

function render(items) {
  counts.textContent = `${items.length} open tab${items.length === 1 ? "" : "s"}`;
  grid.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("article");
    card.className = "card";

    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = it.heroImage || it.favicon || "";
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

    const actions = document.createElement("div");
    actions.className = "actions";

    const openBtn = document.createElement("button");
    openBtn.textContent = "Focus";
    openBtn.onclick = () =>
      chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId: it.tabId, windowId: it.windowId });
    actions.appendChild(openBtn);

    const pinBtn = document.createElement("button");
    pinBtn.textContent = it.pinned ? "Unpin" : "Pin";
    pinBtn.onclick = () =>
      chrome.runtime.sendMessage({ type: "PIN_TOGGLE", tabId: it.tabId });
    actions.appendChild(pinBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.onclick = () =>
      chrome.runtime.sendMessage({ type: "CLOSE_TAB", tabId: it.tabId });
    actions.appendChild(closeBtn);

    const visit = document.createElement("a");
    visit.href = it.url;
    visit.target = "_blank";
    visit.rel = "noreferrer";
    visit.textContent = "Open link";
    actions.appendChild(visit);

    card.appendChild(actions);
    grid.appendChild(card);
  }
}

async function hydrate() {
  const { tabs = [] } = await chrome.storage.session.get("tabs");
  render(tabs);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "TABS_UPDATED") hydrate();
});

hydrate();

// background.js — TabFeed (panel-only summarizer, persistent storage, inject existing tabs)
console.log("[TabFeed] background boot", new Date().toISOString());

// ---------- Constants ----------
const SELF_PREFIX = chrome.runtime.getURL("");           // chrome-extension://<id>/
const PANEL_URL   = chrome.runtime.getURL("panel.html");

// ---------- State ----------
const tabsIndex = new Map(); // tabId -> item
let broadcastTimer = null;

// ---------- Helpers ----------
function isOwnTab(tabOrUrl) {
  const u = typeof tabOrUrl === "string" ? tabOrUrl : (tabOrUrl?.url || "");
  return u && (u.startsWith(SELF_PREFIX) || u === PANEL_URL);
}

function stableSort(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.windowId !== b.windowId) return a.windowId - b.windowId;
  return (a.tabIndex ?? 0) - (b.tabIndex ?? 0);
}

function toItemFromTab(t, prev = {}) {
  return {
    ...prev,
    tabId: t.id,
    windowId: t.windowId,
    tabIndex: t.index ?? prev.tabIndex ?? 0,
    url: t.url || prev.url || "",
    domain: (() => { try { return new URL(t.url).hostname.replace(/^www\./, ""); } catch { return prev.domain || ""; } })(),
    title: t.title || prev.title || "(no title)",
    favicon: t.favIconUrl || prev.favicon || "",
    heroImage: prev.heroImage || "",
    description: prev.description || "",
    fullText: prev.fullText || "",
    summary: prev.summary || "",
    pinned: !!t.pinned,
    audible: !!t.audible,
    updatedAt: Date.now()
  };
}

function mergePayload(it, payload) {
  const merged = { ...it };
  if (payload.url) merged.url = payload.url;
  if (payload.domain) merged.domain = payload.domain;
  if (payload.title) merged.title = payload.title;
  if (payload.favicon) merged.favicon = payload.favicon;
  if (payload.heroImage) merged.heroImage = payload.heroImage;
  if (payload.description) merged.description = payload.description;
  if (payload.fullText && payload.fullText.length > (merged.fullText?.length || 0)) {
    merged.fullText = payload.fullText;
  }
  return merged;
}

async function reconcileAndBroadcast() {
  const openTabs = await chrome.tabs.query({});
  const liveIds = new Set();

  for (const t of openTabs) {
    if (!t.id || isOwnTab(t)) continue;
    liveIds.add(t.id);
    const prev = tabsIndex.get(t.id) || {};
    tabsIndex.set(t.id, toItemFromTab(t, prev));
  }
  for (const id of Array.from(tabsIndex.keys())) {
    if (!liveIds.has(id)) tabsIndex.delete(id);
  }

  const list = [...tabsIndex.values()]
    .filter(it => it.url && !isOwnTab(it.url))
    .sort(stableSort);

  await chrome.storage.local.set({ tabs: list });
  chrome.runtime.sendMessage({ type: "TABS_UPDATED" }).catch(() => {});
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => { reconcileAndBroadcast(); }, 80);
}

async function requestParse(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: "PARSE_NOW" }); } catch {}
}

// ---------- Inject content.js into all open tabs ----------
async function injectContentIntoAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || isOwnTab(t) || !t.url || t.url.startsWith("chrome://") || t.url.startsWith("chrome-extension://")) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id },
        files: ["content.js"]
      });
      await chrome.tabs.sendMessage(t.id, { type: "PARSE_NOW" }).catch(() => {});
      console.log("[TabFeed][bg] injected content.js into", t.url);
    } catch (e) {
      console.warn("[TabFeed][bg] failed to inject into", t.url, e);
    }
  }
}

// ---------- Robust opener ----------
async function openUI(tab) {
  const url = PANEL_URL;
  try {
    if (chrome.sidePanel?.setOptions) {
      await chrome.sidePanel.setOptions({ path: "panel.html", enabled: true });
    }
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab?.windowId });
      await reconcileAndBroadcast();
      await injectContentIntoAllTabs(); // also parse existing
      return;
    }
    throw new Error("sidePanel API unavailable");
  } catch {
    await chrome.tabs.create({ url }).catch(() => {});
    await reconcileAndBroadcast();
    await injectContentIntoAllTabs();
  }
}
chrome.action.onClicked.addListener(openUI);

// ---------- Startup/install ----------
chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel?.setOptions?.({ path: "panel.html", enabled: true }); } catch {}
  await reconcileAndBroadcast();
  await injectContentIntoAllTabs();
});
chrome.runtime.onStartup.addListener(async () => {
  try { await chrome.sidePanel?.setOptions?.({ path: "panel.html", enabled: true }); } catch {}
  await reconcileAndBroadcast();
  await injectContentIntoAllTabs();
});

// ---------- Tab lifecycle ----------
chrome.tabs.onCreated.addListener(async (t) => {
  if (!t.id || isOwnTab(t)) return;
  tabsIndex.set(t.id, toItemFromTab(t, tabsIndex.get(t.id) || {}));
  scheduleBroadcast();
  requestParse(t.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tabId || !tab || isOwnTab(tab)) return;
  tabsIndex.set(tabId, toItemFromTab(tab, tabsIndex.get(tabId) || {}));
  scheduleBroadcast();
  if (changeInfo.status === "complete") requestParse(tabId);
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  const it = tabsIndex.get(tabId);
  if (it) {
    it.tabIndex = moveInfo.toIndex;
    it.windowId = moveInfo.windowId;
    it.updatedAt = Date.now();
    tabsIndex.set(tabId, it);
    scheduleBroadcast();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabsIndex.delete(tabId);
  scheduleBroadcast();
});

// ---------- Messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    try {
      if (msg?.type === "PANEL_OPENED") {
        await reconcileAndBroadcast();
        await injectContentIntoAllTabs();
        sendResponse?.({ ok: true }); return;
      }

      if (msg?.type === "GET_TABS_NOW") {
        const { tabs = [] } = await chrome.storage.local.get("tabs");
        sendResponse?.({ ok: true, tabs }); return;
      }

      if (msg?.type === "TAB_CONTENT" && sender.tab?.id != null) {
        const t = sender.tab;
        if (isOwnTab(t)) { sendResponse?.({ ok: true }); return; }
        const prev = tabsIndex.get(t.id) || {};
        const merged = mergePayload(toItemFromTab(t, prev), msg.payload || {});
        tabsIndex.set(t.id, merged);
        scheduleBroadcast();
        sendResponse?.({ ok: true }); return;
      }

      if (msg?.type === "TAB_SUMMARY_FROM_PANEL") {
        const { tabId, summary } = msg;
        const it = tabsIndex.get(tabId);
        if (it && typeof summary === "string" && summary.trim()) {
          it.summary = summary;
          it.updatedAt = Date.now();
          tabsIndex.set(tabId, it);
          scheduleBroadcast();
        }
        sendResponse?.({ ok: true }); return;
      }

      if (msg?.type === "FOCUS_TAB") {
        await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(msg.windowId, { focused: true });
        sendResponse?.({ ok: true }); return;
      }
      if (msg?.type === "CLOSE_TAB") {
        await chrome.tabs.remove(msg.tabId);
        sendResponse?.({ ok: true }); return;
      }
      if (msg?.type === "PIN_TOGGLE") {
        const t = await chrome.tabs.get(msg.tabId);
        await chrome.tabs.update(msg.tabId, { pinned: !t.pinned });
        const it = tabsIndex.get(msg.tabId);
        if (it) { it.pinned = !t.pinned; it.updatedAt = Date.now(); tabsIndex.set(msg.tabId, it); }
        scheduleBroadcast();
        sendResponse?.({ ok: true }); return;
      }
    } catch (e) {
      console.error("[TabFeed][bg] onMessage error:", e);
    }
    sendResponse?.({ ok: true });
  };

  run();
  return false;
});

console.log("[TabFeed] background ready");

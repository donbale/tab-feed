// background.js — TabFeed (no page-bridge; panel does summaries)
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
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;   // pinned first
  if (a.windowId !== b.windowId) return a.windowId - b.windowId;
  return (a.tabIndex ?? 0) - (b.tabIndex ?? 0);          // by strip order
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

// Build canonical list from Chrome → write storage.session.tabs → notify panel
async function reconcileAndBroadcast() {
  const openTabs = await chrome.tabs.query({});

  const liveIds = new Set();
  for (const t of openTabs) {
    if (!t.id || isOwnTab(t)) continue;
    liveIds.add(t.id);
    const prev = tabsIndex.get(t.id) || {};
    tabsIndex.set(t.id, toItemFromTab(t, prev));
  }
  // prune closed/missing
  for (const id of Array.from(tabsIndex.keys())) {
    if (!liveIds.has(id)) tabsIndex.delete(id);
  }

  const list = [...tabsIndex.values()]
    .filter(it => it.url && !isOwnTab(it.url))
    .sort(stableSort);

  await chrome.storage.session.set({ tabs: list });
  chrome.runtime.sendMessage({ type: "TABS_UPDATED" }).catch(() => {});
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => { reconcileAndBroadcast(); }, 80);
}

async function requestParse(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: "PARSE_NOW" }); } catch {}
}

// ---------- Robust opener (side panel with tab fallback) ----------
async function openUI(tab) {
  const url = PANEL_URL;
  try {
    if (chrome.sidePanel?.setOptions) {
      await chrome.sidePanel.setOptions({ path: "panel.html", enabled: true });
    }
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab?.windowId });
      console.log("[TabFeed][bg] side panel opened");
      await reconcileAndBroadcast();
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.id && !isOwnTab(t)) requestParse(t.id);
      return;
    }
    throw new Error("sidePanel API unavailable");
  } catch (e) {
    console.warn("[TabFeed][bg] side panel open failed, falling back to tab:", e?.message || e);
    await chrome.tabs.create({ url }).catch(() => {});
    await reconcileAndBroadcast();
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id && !isOwnTab(t)) requestParse(t.id);
  }
}
chrome.action.onClicked.addListener(openUI);

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel?.setOptions?.({ path: "panel.html", enabled: true }); } catch {}
  await reconcileAndBroadcast();
});
chrome.runtime.onStartup.addListener(async () => {
  try { await chrome.sidePanel?.setOptions?.({ path: "panel.html", enabled: true }); } catch {}
  await reconcileAndBroadcast();
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
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) if (t.id && !isOwnTab(t)) requestParse(t.id);
        sendResponse?.({ ok: true }); return;
      }

      if (msg?.type === "GET_TABS_NOW") {
        const { tabs = [] } = await chrome.storage.session.get("tabs");
        sendResponse?.({ ok: true, tabs }); return;
      }

      if (msg?.type === "TAB_CONTENT" && sender.tab?.id != null) {
        const t = sender.tab;
        if (isOwnTab(t)) { sendResponse?.({ ok: true }); return; }
        const prev = tabsIndex.get(t.id) || {};
        tabsIndex.set(t.id, {
          ...toItemFromTab(t, prev),
          url: msg.payload?.url || t.url || prev.url || "",
          domain: msg.payload?.domain || prev.domain || "",
          title: msg.payload?.title || t.title || prev.title || "(no title)",
          favicon: msg.payload?.favicon || t.favIconUrl || prev.favicon || "",
          heroImage: msg.payload?.heroImage || prev.heroImage || "",
          description: msg.payload?.description || prev.description || "",
          fullText: msg.payload?.fullText || prev.fullText || "",
        });
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
  return false; // no long-running async ports needed
});

console.log("[TabFeed] background ready");

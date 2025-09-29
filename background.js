// background.js — Tab Feed (stable injector + debounced updates)

console.log("[TabFeed] background boot", new Date().toISOString());

// ---------- side panel ----------
function openUI(tab) {
  if (chrome.sidePanel?.open) {
    chrome.sidePanel.open({ windowId: tab?.windowId });
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL("panel.html") });
  }
}
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setOptions) {
    chrome.sidePanel.setOptions({ path: "panel.html", enabled: true });
  }
});
chrome.action.onClicked.addListener(openUI);

// ---------- tabs index & broadcaster ----------
const tabsIndex = new Map();               // tabId -> item
let broadcastTimer = null;
function broadcastUpdate() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    const list = [...tabsIndex.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    chrome.storage.session.set({ tabs: list });
    chrome.runtime.sendMessage({ type: "TABS_UPDATED" }).catch(() => {});
  }, 80);
}

async function requestParse(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: "PARSE_NOW" }); } catch {}
}

// Parse all tabs on startup/install
async function parseAllOpenTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id) requestParse(t.id);
}
chrome.runtime.onStartup.addListener(parseAllOpenTabs);
chrome.runtime.onInstalled.addListener(parseAllOpenTabs);

// ---------- CSP-safe bridge injection cache ----------
const injectedTabs = new Set(); // tabIds we've injected page-bridge.js into

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    console.log("[TabFeed][bg] msg:", msg?.type, "from tab", sender.tab?.id, msg);

    // Panel ping (no async)
    if (msg?.type === "PANEL_PING") {
      sendResponse?.({ ok: true });
      return; // sync return OK
    }

    // Content -> base payload
    if (msg?.type === "TAB_CONTENT" && sender.tab?.id != null) {
      const tab = sender.tab;
      const prev = tabsIndex.get(tab.id);
      const item = {
        tabId: tab.id,
        windowId: tab.windowId,
        url: msg.payload?.url || tab.url || "",
        domain: msg.payload?.domain || "",
        title: msg.payload?.title || tab.title || "(no title)",
        favicon: msg.payload?.favicon || tab.favIconUrl || "",
        heroImage: msg.payload?.heroImage || "",
        description: msg.payload?.description || "",
        fullText: msg.payload?.fullText || "",
        summary: prev?.summary || "",     // keep any existing summary
        updatedAt: Date.now(),
        pinned: !!tab.pinned,
        audible: !!tab.audible
      };
      tabsIndex.set(tab.id, item);
      broadcastUpdate();
      sendResponse?.({ ok: true });
      return;
    }

    // Content -> summary result (primary path)
    if (msg?.type === "TAB_SUMMARY") {
      const tabId = sender.tab?.id ?? msg.tabId;
      const item = tabsIndex.get(tabId);
      if (item) {
        // Do not overwrite a good summary with an error string
        const incoming = msg.summary || "";
        const isError = incoming.startsWith?.("[TL;DR error:");
        if (!isError && incoming) {
          item.summary = incoming;
        }
        item.updatedAt = Date.now();
        tabsIndex.set(tabId, item);
        broadcastUpdate();
      } else {
        console.warn("[TabFeed][bg] TAB_SUMMARY for unknown tab", tabId);
      }
      sendResponse?.({ ok: true });
      return;
    }

    // Panel fallback (optional)
    if (msg?.type === "TAB_SUMMARY_FROM_PANEL") {
      const { tabId, summary } = msg;
      const item = tabsIndex.get(tabId);
      if (item && typeof summary === "string" && !summary.startsWith("[TL;DR error:")) {
        item.summary = summary;
        item.updatedAt = Date.now();
        tabsIndex.set(tabId, item);
        broadcastUpdate();
      }
      sendResponse?.({ ok: true });
      return;
    }

    // 🔧 CSP-safe injector: use executeScript + return true to keep the port open
    if (msg?.type === "INJECT_BRIDGE") {
      const tabId = sender.tab?.id ?? msg.tabId;

      (async () => {
        try {
          if (!injectedTabs.has(tabId)) {
            await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",            // run in page world, bypassing page CSP
              files: ["page-bridge.js"] // make sure this file exists in the extension root
            });
            injectedTabs.add(tabId);
            console.log("[TabFeed][bg] bridge injected into tab", tabId);
          } else {
            console.log("[TabFeed][bg] bridge already injected", tabId);
          }
          sendResponse?.({ ok: true });
        } catch (e) {
          console.warn("[TabFeed][bg] bridge inject failed:", e);
          sendResponse?.({ ok: false, error: String(e) });
        }
      })();

      return true; // <-- keep the message channel open for sendResponse above
    }

    // Panel commands → tab ops (async; return true)
    if (msg?.type === "FOCUS_TAB") {
      (async () => {
        try {
          await chrome.tabs.update(msg.tabId, { active: true });
          await chrome.windows.update(msg.windowId, { focused: true });
          sendResponse?.({ ok: true });
        } catch (e) {
          sendResponse?.({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    if (msg?.type === "CLOSE_TAB") {
      (async () => {
        try { await chrome.tabs.remove(msg.tabId); sendResponse?.({ ok: true }); }
        catch (e) { sendResponse?.({ ok: false, error: String(e) }); }
      })();
      return true;
    }
    if (msg?.type === "PIN_TOGGLE") {
      (async () => {
        try {
          const t = await chrome.tabs.get(msg.tabId);
          await chrome.tabs.update(msg.tabId, { pinned: !t.pinned });
          sendResponse?.({ ok: true });
        } catch (e) {
          sendResponse?.({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
  } catch (err) {
    console.error("[TabFeed][bg] onMessage error:", err);
  }
  // default safe ack
  sendResponse?.({ ok: true });
  return; // sync return
});

// ---------- tab lifecycle ----------
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") requestParse(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabsIndex.delete(tabId);
  broadcastUpdate();
});

console.log("[TabFeed] background ready");

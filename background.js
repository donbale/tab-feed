// background.js (MV3, side-panel with safe fallback)

function openUI(tab) {
  // If side panel API exists, use it
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab?.windowId });
  } else {
    // Fallback: open the panel page in a normal tab
    chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
  }
}

// Try to register default side panel path if supported
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setOptions) {
    chrome.sidePanel.setOptions({ path: 'panel.html', enabled: true });
  }
});

// Toolbar click -> open UI (side panel if available, else tab)
chrome.action.onClicked.addListener(openUI);

// ---- The rest of your code (tab indexing etc.) goes below ----
const tabsIndex = new Map();

async function requestParse(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'PARSE_NOW' }); } catch {}
}

function broadcastUpdate() {
  const list = [...tabsIndex.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  chrome.storage.session.set({ tabs: list });
  chrome.runtime.sendMessage({ type: 'TABS_UPDATED' }).catch(() => {});
}

chrome.runtime.onStartup.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id) requestParse(t.id);
});

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id) requestParse(t.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TAB_CONTENT' && sender.tab?.id != null) {
    const tab = sender.tab;
    tabsIndex.set(tab.id, {
      tabId: tab.id,
      windowId: tab.windowId,
      url: msg.payload.url || tab.url,
      domain: msg.payload.domain,
      title: msg.payload.title || tab.title || '(no title)',
      favicon: msg.payload.favicon || tab.favIconUrl || '',
      heroImage: msg.payload.heroImage || '',
      description: msg.payload.description || '',
      updatedAt: Date.now(),
      pinned: !!tab.pinned,
      audible: !!tab.audible
    });
    broadcastUpdate();
  }
  sendResponse?.();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') requestParse(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabsIndex.delete(tabId);
  broadcastUpdate();
});

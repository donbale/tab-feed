// background.js — TabFeed (panel-only AI, persistent storage, stable updates)
console.log("[TabFeed] background boot", new Date().toISOString());

// ---------- Constants ----------
const SELF_PREFIX = chrome.runtime.getURL("");           // chrome-extension://<id>/
const PANEL_URL   = chrome.runtime.getURL("panel.html");

// ---------- State ----------
const STATS = {UPDATED:"STATS_UPDATED", CLEAN_NOW:"STATS_CLEAN_NOW"};
const tabsIndex = new Map(); // tabId -> item
let broadcastTimer = null;
let saveTimer = null;
let suggestBundlesTimer = null;
let suggestedBundles = [];
let bundles = [];

async function suggestBundles() {
  const tabs = [...tabsIndex.values()].filter(it => it.fullText && it.fullText.length >= 120);
  if (tabs.length < 3) {
    suggestedBundles = [];
    await saveAndBroadcast();
    return;
  }

  const tabCues = tabs.map(t => ({
    tabId: t.tabId,
    title: t.title,
    description: t.description,
    categories: t.categories,
  }));

  const existingBundleTitles = bundles.map(b => `- "${b.title}"`).join("\n");

  const systemPrompt = `You are a browser tab organizer. Your task is to group related tabs into thematic bundles.
- A bundle should contain at least 3 tabs.
- The title of the bundle should be a short, descriptive summary of the topic (e.g., "React Performance Optimization", "Planning a trip to Japan").
- Do not suggest bundles that are too similar to the existing bundles listed below.
- Return a JSON array of bundle objects, where each object has a "title" and a "tabIds" array.
- If no new bundles can be created, return an empty array.

Existing bundles:
${existingBundleTitles}`;

  const userPrompt = `Here are the open tabs:\n${JSON.stringify(tabCues, null, 2)}`;

  try {
    const lm = await getLM();
    if (!lm) {
      suggestedBundles = [];
      await saveAndBroadcast();
      return;
    }

    const res = await lm.prompt([{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]);
    let parsed;
    try {
      const jsonString = res.replace(/```json\n|```/g, "");
      parsed = JSON.parse(jsonString);
    } catch {
      parsed = [];
    }

    if (Array.isArray(parsed)) {
      suggestedBundles = parsed.filter(b => b.title && Array.isArray(b.tabIds) && b.tabIds.length >= 3);
    } else {
      suggestedBundles = [];
    }
  } catch (e) {
    console.error("[TabFeed][bg] suggestBundles failed", e);
    suggestedBundles = [];
  }

  await saveAndBroadcast();
}

function scheduleSuggestBundles() {
  clearTimeout(suggestBundlesTimer);
  suggestBundlesTimer = setTimeout(suggestBundles, 2000); // 2 second debounce
}

// ---------- Summarizer (moved from panel.js) ----------
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
  } catch (e) {
    console.error("[TabFeed][bg] getSummarizer failed", e);
    return null;
  }
}
async function summarizeMD(text) {
  const inst = await getSummarizer();
  if (!inst) return null;
  try {
    const out = await inst.summarize((text || "").slice(0, 1000), {
      format: "markdown",
      output: { language: "en" }
    });
    return typeof out === "string" ? out : (out?.summary || "");
  } catch (e) {
    console.warn("[TabFeed] Summarize failed", e);
    return null;
  }
}

const lastSummarizedSig = new Map(); // tabId -> sig
let summaryQueue = [];
let summaryRunning = false;
const MAX_CONCURRENT_SUMMARIES = 5;
async function runSummaryQueue() {
  if (summaryRunning) return;
  summaryRunning = true;
  while (summaryQueue.length > 0) {
    const itemsToProcess = summaryQueue.splice(0, MAX_CONCURRENT_SUMMARIES);
    await Promise.all(itemsToProcess.map(async (it) => {
      const md = await summarizeMD(it.fullText);
      if (md) {
        const tab = tabsIndex.get(it.tabId);
        if (tab) {
          tab.summary = md;
          tab.updatedAt = Date.now();
          tabsIndex.set(it.tabId, tab);
        }
      }
    }));
    scheduleSaveAndBroadcast();
    scheduleSuggestBundles();
  }
  summaryRunning = false;
}

// ---------- Classification (moved from panel.js) ----------
async function getLM() {
  try {
    const LM = globalThis.LanguageModel || (globalThis.ai && globalThis.ai.languageModel);
    if (!LM) return null;
    const session = await LM.create?.({
      expectedInputs:  [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    });
    return session || null;
  } catch (e) {
    console.error("[TabFeed][bg] getLM failed", e);
    return null;
  }
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

let classifyQueue = [];
let classifyRunning = false;
async function runClassifyQueue() {
  if (classifyRunning) return;
  classifyRunning = true;
  while (classifyQueue.length > 0) {
    const itemsToProcess = classifyQueue.splice(0, 5); // Process in batches of 5
    await Promise.all(itemsToProcess.map(async (it) => {
      if (!(it.fullText && it.fullText.length >= 120)) return;
      if (Array.isArray(it.categories) && it.categories.length) return;
      const result = await classifyTabContent(it.fullText, it.url, it.title, it.description);
      if (result && result.categories) {
        const tab = tabsIndex.get(it.tabId);
        if (tab) {
          tab.categories = result.categories;
          tab.updatedAt = Date.now();
          tabsIndex.set(it.tabId, tab);
        }
      }
    }));
    scheduleSaveAndBroadcast(); // Broadcast after each batch
    scheduleSuggestBundles();
  }
  classifyRunning = false;
}

async function generateBundleSummaryAndTips(bundle) {
  const tabs = bundle.tabIds.map(id => tabsIndex.get(id)).filter(Boolean);
  const context = tabs.map(t => `Title: ${t.title}\nURL: ${t.url}\nSummary: ${t.summary}\n`).join("\n---\n");

  const summaryPrompt = `Summarize the following content from a bundle of tabs:\n${context}`;
  const tipsPrompt = `Based on the following content, suggest 3-5 next steps for the user:\n${context}`;

  try {
    const lm = await getLM();
    if (!lm) return;

    const summary = await lm.prompt([{ role: "user", content: summaryPrompt }]);
    const tipsResponse = await lm.prompt([{ role: "user", content: tipsPrompt }]);
    const tips = tipsResponse.split("\n").map(t => t.replace(/^- /, "")).filter(Boolean);

    bundle.summary = summary;
    bundle.tips = tips;

    await saveAndBroadcast();
  } catch (e) {
    console.error("[TabFeed][bg] generateBundleSummaryAndTips failed", e);
  }
}

// ---------- Entity Extraction (moved from panel.js) ----------
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

let entitiesQueue = [];
let entitiesRunning = false;
async function runEntitiesQueue() {
  if (entitiesRunning) return;
  entitiesRunning = true;
  while (entitiesQueue.length > 0) {
    const itemsToProcess = entitiesQueue.splice(0, 5); // Process in batches of 5
    await Promise.all(itemsToProcess.map(async (it) => {
      if (!(it.fullText && it.fullText.length >= 120)) return;
      if (it.entities && (it.entities.people?.length || it.entities.orgs?.length || it.entities.places?.length)) return;
      const ents = await extractEntities(it.fullText, it.url, it.title, it.description);
      if (ents) {
        const tab = tabsIndex.get(it.tabId);
        if (tab) {
          tab.entities = ents;
          tab.updatedAt = Date.now();
          tabsIndex.set(it.tabId, tab);
        }
      }
    }));
    scheduleSaveAndBroadcast(); // Broadcast after each batch
    scheduleSuggestBundles();
  }
  entitiesRunning = false;
}



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
    categories: prev.categories || [],
    pinned: !!t.pinned,
    audible: !!t.audible,
    updatedAt: Date.now()
  };
}

// Only overwrite fields if incoming payload has real content
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
  if (Array.isArray(payload.categories) && payload.categories.length) {
    merged.categories = payload.categories;
  }
  return merged;
}

async function saveAndBroadcast() {
  const list = [...tabsIndex.values()]
    .filter(it => it.url && !isOwnTab(it.url))
    .sort(stableSort);

  await chrome.storage.local.set({ tabs: list, suggestedBundles, bundles });
  chrome.runtime.sendMessage({ type: "TABS_UPDATED" }).catch(() => {});
}

function scheduleSaveAndBroadcast() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAndBroadcast, 1000);
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
  // prune closed
  for (const id of Array.from(tabsIndex.keys())) {
    if (!liveIds.has(id)) tabsIndex.delete(id);
  }

  await saveAndBroadcast();
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => { reconcileAndBroadcast(); }, 500);
}

async function requestParse(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: "PARSE_NOW" }); } catch {}
}

// ---------- Hydrate from storage.local at boot ----------
async function hydrateFromStorage() {
  try {
    const { tabs = [], bundles: storedBundles = [] } = await chrome.storage.local.get(["tabs", "bundles"]);
    if (Array.isArray(tabs)) {
      for (const it of tabs) {
        if (it.tabId != null) tabsIndex.set(it.tabId, it);
      }
      console.log("[TabFeed][bg] hydrated from storage:", tabs.length, "items");
    }
    if (Array.isArray(storedBundles)) {
      bundles = storedBundles;
      console.log("[TabFeed][bg] hydrated bundles from storage:", bundles.length, "bundles");
    }
  } catch (e) {
    console.warn("[TabFeed][bg] hydrateFromStorage failed:", e);
  }
}

// ---------- Inject content.js into all open tabs (so old tabs get text) ----------
async function injectContentIntoAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || isOwnTab(t) || !t.url) continue;
    if (t.url.startsWith("chrome://") || t.url.startsWith("edge://") || t.url.startsWith("chrome-extension://")) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id },
        files: ["content.js"]
      });
      await chrome.tabs.sendMessage(t.id, { type: "PARSE_NOW" }).catch(() => {});
    } catch {
      // some pages cannot be injected — ignore
    }
  }
}

// ---------- Google/SPA pass: re-ask every tab to parse (no injection) ----------
async function forceReparseAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id && !isOwnTab(t)) requestParse(t.id);
    }
  } catch {}
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
      await injectContentIntoAllTabs();   // ensure older tabs have content.js
      await forceReparseAllTabs();        // and ask all to parse now (good for Google/SPAs)
      return;
    }
    throw new Error("sidePanel API unavailable");
  } catch {
    await chrome.tabs.create({ url }).catch(() => {});
    await reconcileAndBroadcast();
    await injectContentIntoAllTabs();
    await forceReparseAllTabs();
  }
}
chrome.action.onClicked.addListener(openUI);

// ---------- Startup/install ----------
chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel?.setOptions?.({ path: "panel.html", enabled: true }); } catch {}
  await hydrateFromStorage();
  await reconcileAndBroadcast();
  await injectContentIntoAllTabs();
  await forceReparseAllTabs();
});
chrome.runtime.onStartup.addListener(async () => {
  try { await chrome.sidePanel?.setOptions?.({ path: "panel.html", enabled: true }); } catch {}
  await hydrateFromStorage();
  await reconcileAndBroadcast();
  await injectContentIntoAllTabs();
  await forceReparseAllTabs();
});

// ---------- Tab lifecycle ----------
chrome.tabs.onCreated.addListener(async (t) => {
  if (!t.id || isOwnTab(t)) return;
  tabsIndex.set(t.id, toItemFromTab(t, tabsIndex.get(t.id) || {}));
  scheduleBroadcast();
  requestParse(t.id);
});

// Re-parse on URL change OR when load completes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tabId || !tab || isOwnTab(tab)) return;
  tabsIndex.set(tabId, toItemFromTab(tab, tabsIndex.get(tabId) || {}));
  scheduleBroadcast();

  // If the URL changed (SPA sometimes updates url without "complete")
  if (changeInfo.url) requestParse(tabId);

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
  if (tabsIndex.has(tabId)) tabsIndex.delete(tabId);
  scheduleBroadcast();
});

// ---------- ALSO catch SPA navigations ----------
chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  // pushState/replaceState navigations (same document)
  if (details.frameId !== 0) return; // main frame only
  requestParse(details.tabId);
});

chrome.webNavigation?.onCommitted?.addListener((details) => {
  // new document commits
  if (details.frameId !== 0) return;
  requestParse(details.tabId);
});

// ---------- Messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    try {
      if (msg?.type === "PANEL_OPENED") {
        await hydrateFromStorage();                 // if SW just woke up
        await reconcileAndBroadcast();
        await injectContentIntoAllTabs();
        await forceReparseAllTabs();
        sendResponse?.({ ok: true }); return;
      }

      if (msg?.type === "GET_TABS_NOW") {
        const { tabs = [], suggestedBundles = [], bundles = [] } = await chrome.storage.local.get(["tabs", "suggestedBundles", "bundles"]);
        sendResponse?.({ ok: true, tabs, suggestedBundles, bundles }); return;
      }

      if (msg?.type === "TAB_CONTENT" && sender.tab?.id != null) {
        const t = sender.tab;
        if (isOwnTab(t)) { sendResponse?.({ ok: true }); return; }
        const prev = tabsIndex.get(t.id) || {};
        const merged = mergePayload(toItemFromTab(t, prev), msg.payload || {});
        tabsIndex.set(t.id, merged);

        // Summarize if needed
        const sig = [(merged.url || ""), (merged.title || ""), (merged.fullText ? merged.fullText.length : 0)].join("|");
        const prevSig = lastSummarizedSig.get(t.id);
        if (merged.fullText && merged.fullText.length >= 120 && prevSig !== sig) {
          console.log(`[TabFeed][bg] Queuing summary for tab ${t.id}`);
          summaryQueue.push(merged);
          lastSummarizedSig.set(t.id, sig);
          runSummaryQueue();
        }

        // Classify if needed
        if ((!Array.isArray(merged.categories) || merged.categories.length === 0) &&
            merged.fullText && merged.fullText.length >= 120) {
          // Check if the tab is already in the queue
          if (!classifyQueue.some(item => item.tabId === merged.tabId)) {
            classifyQueue.push(merged);
          }
          runClassifyQueue();
        }

        // Extract entities if needed
        if (merged.fullText && merged.fullText.length >= 120 &&
            !(merged.entities && (merged.entities.people?.length || merged.entities.orgs?.length || merged.entities.places?.length))) {
          entitiesQueue.push(merged);
          runEntitiesQueue();
        }

        scheduleBroadcast();
        sendResponse?.({ ok: true }); return;
      }

      if (msg?.type === "ASK_QUESTION") {
        const { question, bundle } = msg;
        const tabs = bundle.tabIds.map(id => tabsIndex.get(id)).filter(Boolean);
        const context = tabs.map(t => `Title: ${t.title}\nURL: ${t.url}\nSummary: ${t.summary}\n`).join("\n---\n");

        const systemPrompt = `You are an expert research assistant. Answer the user's question based on the provided context from the bundled tabs.`;
        const userPrompt = `Context:\n${context}\n\nQuestion: ${question}`;

        try {
          const lm = await getLM();
          if (!lm) {
            sendResponse?.({ answer: "Sorry, the Language Model is not available." });
            return;
          }
          const answer = await lm.prompt([{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]);
          sendResponse?.({ answer });
        } catch (e) {
          console.error("[TabFeed][bg] ASK_QUESTION failed", e);
          sendResponse?.({ answer: "Sorry, I couldn't answer the question." });
        }
        return;
      }

      if (msg?.type === "GET_BUNDLE") {
        const bundle = bundles.find(b => b.id === msg.id);
        if (bundle) {
          const tabs = bundle.tabIds.map(id => tabsIndex.get(id)).filter(Boolean);
          sendResponse?.({ ok: true, bundle, tabs });
        } else {
          sendResponse?.({ ok: false });
        }
        return;
      }

      if (msg?.type === "CREATE_BUNDLE") {
        const newBundle = {
          id: `bundle-${Date.now()}`,
          title: msg.title,
          tabIds: msg.tabIds,
          summary: "",
          tips: [],
        };
        bundles.push(newBundle);
        suggestedBundles = []; // Clear suggestions
        await saveAndBroadcast();
        generateBundleSummaryAndTips(newBundle);
        scheduleSuggestBundles(); // Re-suggest after creating a bundle
        sendResponse?.({ ok: true });
        return;
      }

      // ---- panel commands ----
      if (msg?.type === "FOCUS_TAB") {
        await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(msg.windowId, { focused: true });
        sendResponse?.({ ok: true }); return;
      }

      if (msg?.type === "CLOSE_TAB") {
        try {
          await chrome.tabs.remove(msg.tabId);
        } finally {
          if (tabsIndex.has(msg.tabId)) tabsIndex.delete(msg.tabId);
          await saveAndBroadcast();
        }
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
  return true;
});

// ---------- Kick startup work (NO top-level await) ----------
async function init() {
  await hydrateFromStorage();
  await reconcileAndBroadcast();
  await injectContentIntoAllTabs();
  await forceReparseAllTabs();
}
init();

console.log("[TabFeed] background ready");


// ===== Session Stats & Privacy Flags =====
const requestLog = new Map(); // tabId -> {count1m, lastPrune, thirdParty, trackers, mixedContent}
const trackersList = [
  "google-analytics.com","googletagmanager.com","doubleclick.net","facebook.com",
  "adservice.google.com","adsystem.com","quantserve.com","scorecardresearch.com",
  "mixpanel.com","segment.com","hotjar.com","braze.com","newrelic.com","sentry.io"
];
let lastCleanAt = 0;
chrome.storage.local.get({lastCleanAt: 0}, (d)=>{ lastCleanAt = d.lastCleanAt || 0; });

function hostname(u){ try { return new URL(u).hostname; } catch(e){ return ""; } }

function pruneRequests(tabId){
  const rec = requestLog.get(tabId);
  if (!rec) return;
  const now = Date.now();
  // keep 2-minute window buckets
  rec.events = (rec.events||[]).filter(t => now - t < 120000);
  rec.count1m = rec.events.filter(t => now - t < 60000).length;
  requestLog.set(tabId, rec);
}

chrome.webRequest.onCompleted.addListener((details) => {
  const {tabId, url, initiator} = details;
  if (tabId < 0) return;
  let rec = requestLog.get(tabId) || {events:[], thirdParty:0, trackers:0, mixedContent:false};
  rec.events.push(Date.now());
  // third-party
  try{
    const uHost = new URL(url).hostname;
    const initHost = initiator ? new URL(initiator).hostname : "";
    if (initHost && uHost && !uHost.endsWith(initHost) && !initHost.endsWith(uHost)) {
      rec.thirdParty++;
    }
    // trackers
    if (trackersList.some(t => uHost.includes(t))) {
      rec.trackers++;
    }
  }catch(e){}
  requestLog.set(tabId, rec);
  pruneRequests(tabId);
}, {urls:["<all_urls>"]});

chrome.webRequest.onBeforeRequest.addListener((details)=>{
  // mark mixed content: main page https but subresource http
  const {tabId, url, type, initiator} = details;
  if (tabId < 0) return;
  try{
    const isHttp = url.startsWith("http://");
    const initHttps = initiator && initiator.startsWith("https://");
    if (isHttp && initHttps) {
      const rec = requestLog.get(tabId) || {events:[], thirdParty:0, trackers:0, mixedContent:false};
      rec.mixedContent = true;
      requestLog.set(tabId, rec);
    }
  }catch(e){}
}, {urls:["<all_urls>"]});

async function getMicrophoneCameraFlags(tab) {
  return new Promise((resolve) => {
    const primaryUrl = tab.url || "https://example.com/";
    chrome.contentSettings.microphone.get({primaryUrl}, (mic) => {
      chrome.contentSettings.camera.get({primaryUrl}, (cam) => {
        resolve({micAllowed: mic?.setting === "allow", camAllowed: cam?.setting === "allow"});
      });
    });
  });
}

async function buildSessionStats() {
  const tabs = await chrome.tabs.query({});
  const openTabs = tabs.length;
  const domainsMap = {};
  for (const t of tabs) {
    const u = t.url || "";
    let h = "";
    try {
      const parsed = new URL(u);
      // Skip extension/internal pages
      if (parsed.protocol === "chrome-extension:" || parsed.protocol === "moz-extension:" || parsed.protocol === "edge:") continue;
      h = parsed.hostname || "";
    } catch(e) { h = ""; }
    if (!h) continue;
    // Filter out generic "extensions" page and 32-char extension IDs
    if (h === "extensions" || /^[a-p]{32}$/.test(h)) continue;
    domainsMap[h] = (domainsMap[h]||0) + 1;
  }
  const uniqueDomains = Object.keys(domainsMap).length;

  // approximate memory: 80 MB base + 40 MB per tab (very rough)
  const memoryEstimateMB = Math.round(80 + openTabs * 40);

  // hot tabs by recent request volume
  const hot = tabs.map(t => {
    pruneRequests(t.id);
    const rec = requestLog.get(t.id) || {count1m:0};
    
  

  return {tabId:t.id, title:t.title||"", count1m: rec.count1m||0};
  }).sort((a,b)=>b.count1m - a.count1m).slice(0,5);

  // context score based on titles similarity
  const titles = tabs.map(t => (t.title || "") + " " + (t.url||""));
  function tokenize(s){ return (s.toLowerCase().match(/[a-z0-9]{3,}/g)||[])}
  const vecs = titles.map(t => {
    const v = {};
    for (const w of tokenize(t)) v[w]=(v[w]||0)+1;
    // normalize
    const norm = Math.sqrt(Object.values(v).reduce((a,b)=>a+b*b,0)) || 1;
    for (const k in v) v[k]=v[k]/norm;
    return v;
  });
  function dot(a,b){ let s=0; for (const k in a){ if (b[k]) s+= a[k]*b[k]; } return s; }
  let pairs=0, sum=0;
  for (let i=0;i<vecs.length;i++){
    for (let j=i+1;j<vecs.length;j++){
      sum += dot(vecs[i], vecs[j]);
      pairs++;
    }
  }
  const contextScore = pairs ? Math.round((sum/pairs)*100) : 100;

  // categories quick chips
  const categories = {Docs:0, News:0, Dev:0, Shopping:0};
  for (const t of tabs) {
    const u = t.url||"";
    if (/\.(docs|sheets|slides)\.google\.com|notion\.so|dropbox\.com|onedrive\.live\.com/.test(u)) categories.Docs++;
    if (/news|nytimes|bbc\.co\.uk|theguardian|reuters|bloomberg|cnn\.com/.test(u)) categories.News++;
    if (/github\.com|gitlab\.com|stack(overflow|exchange)\.com|developer\.mozilla|npmjs\.com|reactjs|mdn/.test(u)) categories.Dev++;
    if (/amazon\.[a-z.]+|ebay\.[a-z.]+|aliexpress|etsy\.com|bestbuy|argos\.co\.uk/.test(u)) categories.Shopping++;
  }

  // --- Security & Safety counts ---
  let insecureTabs = 0;
  let tabsWithTrackers = 0;
  const riskyTLDs = new Set(["zip","xyz","top","gq","tk","work","click","country","kim","men","loan"]);
  const riskyBlocklist = new Set([
    // Add any known-bad or suspicious domains you care about here
    "example-malware.test","badexample.com","phishy-login.com"
  ]);
  const domainCounts = {}; // already have domainsMap but we reuse for clarity
  for (const [host,count] of Object.entries(domainsMap)) domainCounts[host]=count;

  // Compute insecure & trackers per tab, and gather risky domains
  const riskyDomainsSet = new Set();
  for (const t of tabs) {
    try {
      const u = new URL(t.url || "");
      if (u.protocol === "http:") insecureTabs++;
      const rec = requestLog.get(t.id) || {trackers:0};
      if ((rec.trackers||0) > 0) tabsWithTrackers++;
      const host = u.hostname || "";
      if (host) {
        const parts = host.split(".");
        const tld = parts[parts.length-1] || "";
        const uncommon = (domainsMap[host]||0) === 1;
        const tldRisk = riskyTLDs.has(tld.toLowerCase());
        const listed = riskyBlocklist.has(host.toLowerCase());
        if (listed || (uncommon && tldRisk)) {
          riskyDomainsSet.add(host);
        }
      }
    } catch(e) {}
  }
  const riskyDomains = Array.from(riskyDomainsSet).sort();

  return { openTabs, uniqueDomains, memoryEstimateMB, hot,
    insecureTabs, tabsWithTrackers, riskyDomainsCount: riskyDomains.length, riskyDomains,
    timeSinceLastCleanMs: lastCleanAt ? (Date.now()-lastCleanAt) : null,
    categories, domainsTop: Object.entries(domainsMap).sort((a,b)=>b[1]-a[1]).slice(0,10)
  };
}

async function getPrivacyFlagsForTabs() {
  const tabs = await chrome.tabs.query({});
  const flags = {};
  for (const t of tabs) {
    const rec = requestLog.get(t.id) || {thirdParty:0, trackers:0, mixedContent:false};
    const micCam = await getMicrophoneCameraFlags(t);
    flags[t.id] = {
      thirdParty: rec.thirdParty||0,
      trackers: rec.trackers||0,
      mixedContent: !!rec.mixedContent,
      micAllowed: micCam.micAllowed,
      camAllowed: micCam.camAllowed,
      audible: !!t.audible
    };
  }
  return flags;
}

async function broadcastStats(){
  const stats = await buildSessionStats();
  const flags = await getPrivacyFlagsForTabs();
  chrome.runtime.sendMessage({type: STATS.UPDATED, stats, privacy: flags});
}

chrome.tabs.onUpdated.addListener(()=>{ broadcastStats(); });
chrome.tabs.onCreated.addListener(()=>{ broadcastStats(); });
chrome.tabs.onRemoved.addListener(()=>{ broadcastStats(); });
chrome.webRequest.onCompleted.addListener(()=>{ broadcastStats(); }, {urls:["<all_urls>"]});
chrome.webRequest.onBeforeRequest.addListener(()=>{ broadcastStats(); }, {urls:["<all_urls>"]});

// handle clean now
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === STATS.CLEAN_NOW) {
    lastCleanAt = Date.now();
    chrome.storage.local.set({lastCleanAt});
    broadcastStats();
    sendResponse({ok:true, lastCleanAt});
    return true;
  }
});


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg === "PANEL_PING" || msg?.type === "PANEL_PING") {
    broadcastStats();
    sendResponse && sendResponse({ok:true});
    return true;
  }
});

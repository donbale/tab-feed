// background.js — TabFeed (panel-only AI, persistent storage, stable updates)
console.log("[TabFeed] background boot", new Date().toISOString());

// ---------- Constants ----------
const SELF_PREFIX = chrome.runtime.getURL("");           // chrome-extension://<id>/
const PANEL_URL   = chrome.runtime.getURL("panel.html");

// ---------- State ----------
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
  // Tips: generate actionable, link-based suggestions deterministically (SW may not have LM)

  try {
    const lm = await getLM();
    if (!lm) return;

    const summary = await lm.prompt([{ role: "user", content: summaryPrompt }]);
    const tips = buildActionableTips(bundle.title || tabs[0]?.title || "");

    bundle.summary = summary;
    bundle.tips = tips;

    await saveAndBroadcast();
  } catch (e) {
    console.error("[TabFeed][bg] generateBundleSummaryAndTips failed", e);
  }
}

function buildActionableTips(subjectRaw="") {
  const subject = (subjectRaw||"").trim() || "this topic";
  const enc = encodeURIComponent;
  const tips = [
    { label: `Find background on ${subject}`, url: `https://www.google.com/search?q=${enc(subject)}` },
    { label: `Latest news on ${subject}`, url: `https://www.google.com/search?q=${enc(subject)}&tbm=nws` },
    { label: `Wikipedia overview`, url: `https://en.wikipedia.org/wiki/Special:Search?search=${enc(subject)}` },
    { label: `Reddit discussions`, url: `https://www.reddit.com/search/?q=${enc(subject)}` },
    { label: `YouTube explainers`, url: `https://www.youtube.com/results?search_query=${enc(subject)}` },
    { label: `Top attractions in ${subject}`, url: `https://www.tripadvisor.com/Search?q=${enc('top attractions ' + subject)}` }
  ];
  return tips;
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
            // Persist failed attempt as well for history visibility
            try {
              const idx = bundles.findIndex(b => b.id === bundle.id);
              if (idx >= 0) {
                const record = { ts: Date.now(), question, answer: "(LM unavailable)", error: true };
                bundles[idx].chat = Array.isArray(bundles[idx].chat) ? bundles[idx].chat : [];
                bundles[idx].chat.push(record);
                await saveAndBroadcast();
              }
            } catch {}
            sendResponse?.({ answer: "Sorry, the Language Model is not available." });
            return;
          }
          const answer = await lm.prompt([{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]);
          // Save Q&A into bundle chat history
          try {
            const idx = bundles.findIndex(b => b.id === bundle.id);
            if (idx >= 0) {
              const record = { ts: Date.now(), question, answer };
              bundles[idx].chat = Array.isArray(bundles[idx].chat) ? bundles[idx].chat : [];
              bundles[idx].chat.push(record);
              await saveAndBroadcast();
            }
          } catch {}
          sendResponse?.({ answer });
        } catch (e) {
          console.error("[TabFeed][bg] ASK_QUESTION failed", e);
          try {
            const idx = bundles.findIndex(b => b.id === bundle.id);
            if (idx >= 0) {
              const record = { ts: Date.now(), question, answer: "(error)", error: true };
              bundles[idx].chat = Array.isArray(bundles[idx].chat) ? bundles[idx].chat : [];
              bundles[idx].chat.push(record);
              await saveAndBroadcast();
            }
          } catch {}
          sendResponse?.({ answer: "Sorry, I couldn't answer the question." });
        }
        return;
      }

      if (msg?.type === "GET_BUNDLE") {
        const bundle = bundles.find(b => b.id === msg.id);
        if (bundle) {
          // Prefer live tabs; fall back to saved items snapshot (by tabId or URL)
          const liveTabs = new Map();
          for (const id of bundle.tabIds || []) {
            const it = tabsIndex.get(id);
            if (it) liveTabs.set(id, it);
          }
          const savedItems = Array.isArray(bundle.items) ? bundle.items : [];
          const urlToSaved = new Map(savedItems.map(si => [si.url, si]));
          const merged = [];
          for (const id of bundle.tabIds || []) {
            const live = liveTabs.get(id);
            if (live) { merged.push(live); continue; }
            // fallback by saved snapshot matching tabId or URL
            const snap = savedItems.find(si => si.tabId === id) || urlToSaved.get((tabsIndex.get(id)?.url)||"");
            if (snap) merged.push(snap);
          }
          // also include any saved items that no longer have tabIds listed (defensive)
          for (const si of savedItems) {
            if (!((bundle.tabIds||[]).includes(si.tabId)) && !merged.find(m => m.url === si.url)) {
              merged.push(si);
            }
          }
          sendResponse?.({ ok: true, bundle, tabs: merged });
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
          chat: [],
        };
        bundles.push(newBundle);
        suggestedBundles = []; // Clear suggestions
        await saveAndBroadcast();
        // Keep background-side generation best-effort; UI now also handles in-page generation
        generateBundleSummaryAndTips(newBundle);
        scheduleSuggestBundles(); // Re-suggest after creating a bundle
        sendResponse?.({ ok: true });
        return;
      }

      if (msg?.type === "SAVE_BUNDLE_AND_CLOSE") {
        const idx = bundles.findIndex(b => b.id === msg.id);
        if (idx < 0) { sendResponse?.({ ok: false }); return; }
        const b = bundles[idx];
        // Snapshot current tab data for persistence
        const items = (b.tabIds || []).map(id => tabsIndex.get(id)).filter(Boolean).map(it => ({
          tabId: it.tabId,
          url: it.url,
          domain: it.domain,
          title: it.title,
          favicon: it.favicon,
          heroImage: it.heroImage,
          description: it.description,
          fullText: it.fullText,
          summary: it.summary,
          categories: Array.isArray(it.categories) ? it.categories.slice(0) : [],
          entities: it.entities ? JSON.parse(JSON.stringify(it.entities)) : undefined,
          readingMinutes: it.readingMinutes,
          savedAt: Date.now()
        }));
        bundles[idx].items = items;
        bundles[idx].archived = true;
        bundles[idx].savedAt = Date.now();
        await saveAndBroadcast();

        // Close tabs that are still open
        try {
          const closeIds = (b.tabIds || []).filter(id => !!tabsIndex.get(id));
          if (closeIds.length) await chrome.tabs.remove(closeIds);
        } catch (e) {
          console.warn("[TabFeed][bg] closing tabs for bundle failed", e);
        } finally {
          await reconcileAndBroadcast();
        }
        sendResponse?.({ ok: true });
        return;
      }

      if (msg?.type === "UPDATE_BUNDLE_META") {
        const { id, summary, tips } = msg;
        const idx = bundles.findIndex(b => b.id === id);
        if (idx >= 0) {
          if (typeof summary === "string") bundles[idx].summary = summary;
          if (Array.isArray(tips)) bundles[idx].tips = tips;
          await saveAndBroadcast();
          sendResponse?.({ ok: true });
        } else {
          sendResponse?.({ ok: false });
        }
        return;
      }

      if (msg?.type === "REMOVE_TAB_FROM_BUNDLE") {
        const { id, tabId, url } = msg;
        const idx = bundles.findIndex(b => b.id === id);
        if (idx < 0) { sendResponse?.({ ok: false }); return; }
        const b = bundles[idx];
        // Remove from tabIds by tabId or by matching saved item URL
        if (tabId != null) {
          b.tabIds = (b.tabIds || []).filter(tid => tid !== tabId);
        } else if (url) {
          // find any tabId that matches saved snapshot URL
          const targets = new Set((b.items||[]).filter(si => si.url === url).map(si => si.tabId).filter(v => v != null));
          if (targets.size) b.tabIds = (b.tabIds||[]).filter(tid => !targets.has(tid));
        }
        // Also prune saved items if present
        if (url) {
          b.items = (b.items || []).filter(si => si.url !== url);
        } else if (tabId != null) {
          b.items = (b.items || []).filter(si => si.tabId !== tabId);
        }
        bundles[idx] = b;
        await saveAndBroadcast();
        sendResponse?.({ ok: true, bundle: b });
        return;
      }

      if (msg?.type === "ADD_TAB_TO_BUNDLE") {
        const { id, tabId } = msg;
        if (tabId == null) { sendResponse?.({ ok:false }); return; }
        const idx = bundles.findIndex(b => b.id === id);
        if (idx < 0) { sendResponse?.({ ok:false }); return; }
        const b = bundles[idx];
        b.tabIds = Array.isArray(b.tabIds) ? b.tabIds : [];
        if (!b.tabIds.includes(tabId)) b.tabIds.push(tabId);
        // If items snapshot exists and same tab/url is present, do nothing; live merge handles it.
        bundles[idx] = b;
        await saveAndBroadcast();
        sendResponse?.({ ok:true, bundle: b });
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

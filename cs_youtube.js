// Content script injected in MAIN world on YouTube watch pages.
// Order: Try DOM transcript (open menu -> "Show transcript"), else youtubei get_transcript, else captionTracks, then timedtext, then description.
(() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitForSelector(selector, timeout = 4000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  function getMenuButton() {
    // Various selectors for "More actions" on the watch page
    return document.querySelector('ytd-menu-renderer yt-icon-button button[aria-label*="More actions"]')
        || document.querySelector('button[aria-label*="More actions"]')
        || document.querySelector('#menu button[aria-label*="More actions"]')
        || document.querySelector('#button-shape button[aria-label*="More actions"]');
  }

  async function tryOpenTranscriptPanel() {
    // If already present, use it
    const existing = document.querySelector("ytd-transcript-search-panel-renderer, ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-transcript-search-panel']");
    if (existing) return true;

    const btn = getMenuButton();
    if (!btn) return false;
    btn.click();
    // Wait for the popup menu
    const popup = await waitForSelector("ytd-popup-container tp-yt-paper-listbox, ytd-menu-popup-renderer");
    if (!popup) return false;

    // Find the "Show transcript" item by text
    let serviceItems = popup.querySelectorAll("ytd-menu-service-item-renderer");
    // If not loaded yet, give it a short moment
    if (!serviceItems.length) {
      await sleep(200);
      serviceItems = popup.querySelectorAll("ytd-menu-service-item-renderer");
    }

    for (const it of serviceItems) {
      const txt = (it.textContent || "").trim().toLowerCase();
      if (txt.includes("show transcript") || txt.includes("transcript")) {
        const clickable = it.querySelector("tp-yt-paper-item, button, a") || it;
        clickable.click();
        // Wait for transcript panel to mount
        const panel = await waitForSelector("ytd-transcript-search-panel-renderer, ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-transcript-search-panel']");
        if (panel) return true;
      }
    }
    return false;
  }

  function readTranscriptFromDOM() {
    const selList = [
      "ytd-transcript-segment-renderer #segment-text",
      "ytd-transcript-segment-renderer .segment-text",
      "ytd-transcript-segment-renderer yt-formatted-string#segment-text",
      "ytd-transcript-segment-renderer yt-formatted-string.segment-text",
      "ytd-transcript-segment-renderer [id*='segment'][class*='text']",
      "ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer"
    ];

    const segments = document.querySelectorAll(selList.join(","));
    if (segments && segments.length) {
      const out = Array.from(segments).map(e => (e.textContent || "").trim()).filter(Boolean).join(" ");
      const text = out.replace(/\s+/g, " ").trim();
      if (text) return { text, lang: null, source: "transcript-dom" };
    }
    return null;
  }

  function safeJsonParse(t) { try { return JSON.parse(t); } catch { return null; } }
  function findInlineJsonByMarker(marker) {
    for (const s of document.querySelectorAll("script")) {
      const txt = s.textContent || "";
      if (txt.includes(marker)) {
        const m = txt.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;"));
        if (m) { const j = safeJsonParse(m[1]); if (j) return j; }
      }
    }
    return null;
  }
  function getYtCfg() {
    const w = window;
    const cfg = (w.ytcfg && (w.ytcfg.get ? w.ytcfg.get() : w.ytcfg.data_)) || {};
    const apikey = cfg.INNERTUBE_API_KEY || cfg.INNERTUBE_API_KEY_DOMESTIC;
    const context = cfg.INNERTUBE_CONTEXT;
    const clientName = (cfg.INNERTUBE_CLIENT_NAME || (context && context.client && context.client.clientName));
    const clientVersion = (cfg.INNERTUBE_CLIENT_VERSION || (context && context.client && context.client.clientVersion));
    return { apikey, context, clientName, clientVersion, raw: cfg };
  }
  function deepFindParamsForTranscript(obj) {
    let found = null;
    const visit = (o) => {
      if (!o || typeof o !== "object" || found) return;
      if (o.transcriptEndpoint && o.transcriptEndpoint.params) { found = o.transcriptEndpoint.params; return; }
      if (o.getTranscriptEndpoint && o.getTranscriptEndpoint.params) { found = o.getTranscriptEndpoint.params; return; }
      for (const k in o) visit(o[k]);
    };
    visit(obj);
    return found;
  }
  async function getTranscriptViaYouTubei() {
    const cfg = getYtCfg();
    if (!(cfg.apikey && cfg.context)) return null;
    const yti = findInlineJsonByMarker("ytInitialData") || {};
    let params = deepFindParamsForTranscript(yti);
    if (!params) return null;
    const endpoint = `https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false&key=${encodeURIComponent(cfg.apikey)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": String(cfg.clientName || "WEB"),
        "X-YouTube-Client-Version": String(cfg.clientVersion || "2.20240701.00.00")
      },
      body: JSON.stringify({ context: cfg.context, params })
    });
    if (!res.ok) return null;
    const json = await res.json();
    const texts = [];
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (o.transcriptSegmentRenderer && o.transcriptSegmentRenderer.snippet) {
        const runs = o.transcriptSegmentRenderer.snippet.runs || [];
        for (const r of runs) if (r.text) texts.push(r.text);
      }
      for (const k in o) walk(o[k]);
    };
    walk(json);
    const text = texts.join(" ").replace(/\s+/g, " ").trim();
    return text ? { text, lang: null, source: "youtubei" } : null;
  }

  async function extractInitialPlayerResponse() {
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    return findInlineJsonByMarker("ytInitialPlayerResponse");
  }
  function pickTrackFromList(tracks, prefs) {
    if (!tracks?.length) return null;
    for (const p of prefs) {
      const hit = tracks.find(t => t.languageCode === p || t.lang === p || t.vssId === `.${p}`);
      if (hit) return hit;
    }
    const asr = tracks.find(t => t.kind === "asr");
    return asr || tracks[0];
  }
  async function fetchJson(url) {
    const u = new URL(url);
    if (!u.searchParams.get("fmt")) u.searchParams.set("fmt", "json3");
    const res = await fetch(u.toString(), { credentials: "include" });
    if (!res.ok) throw new Error("captions fetch failed");
    return res.json();
  }
  function json3ToPlainText(json) {
    const evs = json?.events || [];
    const out = [];
    for (const ev of evs) {
      if (!ev?.segs) continue;
      for (const s of ev.segs) {
        if (!s?.utf8) continue;
        out.push(s.utf8.replace(/\s*\[[^\]]+]\s*/g, ""));
      }
      out.push(" ");
    }
    return out.join("").replace(/\s+/g, " ").trim();
  }
  function fallbackDescription() {
    const meta = document.querySelector('meta[name="description"]')?.content || "";
    const rendered = document.querySelector("#description")?.innerText || "";
    return (rendered || meta || "").trim();
  }
  async function fromInitialResponse() {
    const j = await extractInitialPlayerResponse();
    const tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return null;
    const prefs = []; const ui = navigator.language;
    if (ui) { prefs.push(ui, ui.split("-")[0]); }
    prefs.push("en");
    const track = pickTrackFromList(tracks, prefs);
    if (!track?.baseUrl) return null;
    const json = await fetchJson(track.baseUrl);
    const text = json3ToPlainText(json);
    if (!text) return null;
    return { text, lang: track.languageCode, source: "captions" };
  }
  async function fromTimedTextList() {
    const url = new URL(location.href);
    const v = url.searchParams.get("v");
    if (!v) return null;
    const listRes = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(v)}`, { credentials: "include" });
    if (!listRes.ok) return null;
    const xml = await listRes.text();
    const tracks = Array.from(xml.matchAll(/<track\s+[^>]*>/g)).map(tag => ({
      lang: (tag[0].match(/lang_code="(.*?)"/) || [])[1],
      name: (tag[0].match(/name="(.*?)"/) || [])[1],
      kind: (tag[0].match(/kind="(.*?)"/) || [])[1],
    }));
    if (!tracks.length) return null;
    const ui = navigator.language;
    const prefs = [ui, ui?.split("-")?.[0], "en"].filter(Boolean);
    const track = pickTrackFromList(tracks, prefs);
    const params = new URLSearchParams({ v, lang: track.lang, fmt: "json3" });
    if (track.kind) params.set("kind", track.kind);
    if (track.name) params.set("name", track.name);
    const capRes = await fetch(`https://www.youtube.com/api/timedtext?${params}`, { credentials: "include" });
    if (!capRes.ok) return null;
    const json = await capRes.json();
    const text = json3ToPlainText(json);
    if (!text) return null;
    return { text, lang: track.lang, source: "timedtext" };
  }

  
  // New layout: "Show transcript" appears inside the description section
  async function tryClickDescriptionTranscriptButton() {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Scroll to description region to force lazy components to mount
    const desc = document.querySelector("#description") || document.querySelector("ytd-text-inline-expander");
    if (desc && desc.scrollIntoView) desc.scrollIntoView({ block: "center" });
    await sleep(200);

    // Search widely within the below-the-video metadata area
    const scope = document.querySelector("#below") || document;
    let btn = null;
    const candidates = scope.querySelectorAll("button, tp-yt-paper-button, yt-button-shape button, a[role='button']");
    for (const el of candidates) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (t && (t.includes("show transcript") || t === "transcript")) { btn = el; break; }
    }
    if (!btn) return false;
    btn.click();
    // Wait for engagement transcript panel to appear
    for (let i=0; i<20; i++) {
      const panel = document.querySelector("ytd-transcript-search-panel-renderer, ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-transcript-search-panel']");
      if (panel) return true;
      await sleep(150);
    }
    return false;
  }

  async function waitForTranscriptSegments(timeoutMs = 10000) {
    const selList = [
      "ytd-transcript-segment-renderer #segment-text",
      "ytd-transcript-segment-renderer .segment-text",
      "ytd-transcript-segment-renderer yt-formatted-string#segment-text",
      "ytd-transcript-segment-renderer yt-formatted-string.segment-text",
      "ytd-transcript-segment-renderer [id*='segment'][class*='text']",
      "ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer"
    ];

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const segs = document.querySelectorAll(selList.join(","));
      if (segs && segs.length) return Array.from(segs);
      await sleep(150);
    }
    return [];
  }

  async function collectTranscript() {
    // 1) Try clicking the 'Show transcript' button in the description area (new layout)
    try {
      if (await tryClickDescriptionTranscriptButton() || await tryOpenTranscriptPanel()) {
        // Give it a brief moment to render segments
        const segs = await waitForTranscriptSegments(10000);
        if (segs.length) {
          const text = segs.map(e => (e.textContent||'').trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
          if (text) return { text, lang: null, source: 'transcript-dom' };
        }
        const dom1 = readTranscriptFromDOM();
        if (dom1 && dom1.text) return dom1;
      }
    } catch {}

    // 2) Try the internal youtubei endpoint (same content as the panel)
    const yti = await getTranscriptViaYouTubei();
    if (yti && yti.text) return yti;

    // 3) Direct caption tracks
    try { const a = await fromInitialResponse(); if (a) return a; } catch {}

    // 4) Legacy timedtext
    try { const b = await fromTimedTextList(); if (b) return b; } catch {}

    // 5) Description fallback
    const text = fallbackDescription();
    return { text, lang: null, source: "description" };
  }

  window.__collectYTTranscript = collectTranscript;
})();
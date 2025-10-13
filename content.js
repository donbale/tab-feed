// content.js — extract metadata + text; panel handles summarization

// === YouTube Transcript/Description extraction (added) ===
async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function findByText(root, selector, regex) {
  const nodes = root.querySelectorAll(selector);
  for (const n of nodes) {
    const t = (n.textContent || "").trim();
    if (regex.test(t)) return n;
  }
  return null;
}

async function waitFor(predicate, timeoutMs=5000, intervalMs=200){
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await predicate();
      if (v) return v;
    } catch (e) { /* ignore */ }
    await sleep(intervalMs);
  }
  return null;
}

function ytIdFromUrl(u) {
  try {
    const url = new URL(u, location.href);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    // Shorts or other formats
    const m = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{6,})/);
    if (m) return m[1];
  } catch (e) { }
  return "";
}
function ytThumbFromId(id) {
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}


async function tryOpenTranscript() {
  // 1) Try direct "Show transcript" button if present anywhere
  let btn = findByText(document, "button, tp-yt-paper-item, ytd-menu-service-item-renderer", /show transcript/i);
  if (btn) { btn.click(); }

  // 2) If still not visible, open the "More actions" (kebab) menu then click "Show transcript"
  await sleep(250);
  if (!document.querySelector("ytd-transcript-segment-renderer, ytd-transcript-renderer")) {
    const kebab = document.querySelector('ytd-watch-metadata ytd-menu-renderer button[aria-label*="More actions"]') 
               || document.querySelector('ytd-menu-renderer button[aria-label*="More actions"]')
               || document.querySelector('button[aria-label*="More actions"]');
    if (kebab) {
      kebab.click();
      await sleep(200);
      const item = await waitFor(() => findByText(document, "ytd-menu-service-item-renderer, tp-yt-paper-item", /show transcript/i), 3000);
      if (item) item.click();
    }
  }

  // 3) Wait for transcript to render
  const transcriptContainer = await waitFor(() => 
    document.querySelector("ytd-transcript-segment-renderer, ytd-transcript-renderer"), 5000);
  return Boolean(transcriptContainer);
}

function extractTranscriptText() {
  // Newer YouTube: ytd-transcript-segment-renderer
  const segs = document.querySelectorAll("ytd-transcript-segment-renderer");
  if (segs.length) {
    let parts = [];
    for (const s of segs) {
      // Try common text containers
      const t1 = s.querySelector(".segment-text") || s.querySelector("yt-formatted-string");
      const txt = (t1 ? t1.textContent : s.textContent) || "";
      const clean = txt.replace(/\s+/g, " ").trim();
      if (clean) parts.push(clean);
    }
    return parts.join(" ");
  }
  // Older component fallback
  const legacy = document.querySelector("ytd-transcript-renderer");
  if (legacy) {
    const t = (legacy.textContent || "").replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  return "";
}

async function extractDescriptionText() {
  // Expand "Show more" in description if present
  const showMoreBtn = findByText(document, "tp-yt-paper-button, button", /show more/i);
  if (showMoreBtn) { showMoreBtn.click(); await sleep(200); }

  // Description containers can vary
  const selectors = [
    "#description.ytd-text-inline-expander",
    "ytd-text-inline-expander#description-inline-expander",
    "ytd-expander#description",
    "#description"
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt) return txt;
    }
  }
  return "";
}

async function extractYouTube() {
  // Ensure we're on a watch page
  if (!/youtube\.com$/.test(location.hostname) || !/\/watch/.test(location.pathname)) return null;

  // Try transcript first
  let gotTranscript = await tryOpenTranscript();
  let transcriptText = "";
  if (gotTranscript) {
    // Wait a bit for content to fill
    await sleep(300);
    transcriptText = extractTranscriptText();
  }

  if (transcriptText && transcriptText.length > 40) {
    return { text: transcriptText, source: "transcript" };
  }

  // Fallback: description only
  const desc = await extractDescriptionText();
  if (desc && desc.length > 40) {
    return { text: desc, source: "description" };
  }

  // Nothing usable
  return { text: "", source: "none" };
}

function getMeta(selector) {
  const el = document.querySelector(selector);
  return el ? el.getAttribute("content") || "" : "";
}

async function extract() {
  try {
    // YouTube-special handling: ONLY summarize transcript or description
    const yt = await extractYouTube();
    if (yt && (yt.text || "").length > 0) {
      const payload = {
        url: location.href,
        domain: location.hostname.replace(/^www\./, ""),
        title: (document.title || ""),
        siteName: "YouTube",
        favicon: (document.querySelector('link[rel~="icon"]') || {}).href || "",
        heroImage: (typeof getMeta === "function" ? (getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]')) : "") || ytThumbFromId(ytIdFromUrl(location.href)),
        description: (document.querySelector('meta[name="description"]')?.content || ""),
        fullText: yt.text,
        ytSource: yt.source
      };
      chrome.runtime.sendMessage({ type: "TAB_CONTENT", payload }).catch(() => {});
      return;
    }
  } catch (e) {
    // Fall through to default extraction if anything fails
  }

  // Default extraction for non-YouTube pages

  const fullText = (document.body?.innerText || "").slice(0, 50000);
  const payload = {
    url: location.href,
    domain: location.hostname.replace(/^www\./, ""),
    title:
      getMeta('meta[property="og:title"]') ||
      getMeta('meta[name="twitter:title"]') ||
      document.title || "",
    favicon: (document.querySelector('link[rel~="icon"]') || {
}).href || "",
    heroImage:
      getMeta('meta[property="og:image"]') ||
      getMeta('meta[name="twitter:image"]') || "",
    description:
      getMeta('meta[name="description"]') ||
      getMeta('meta[property="og:description"]') ||
      getMeta('meta[name="twitter:description"]') || "",
    fullText
  };
  chrome.runtime.sendMessage({ type: "TAB_CONTENT", payload }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PARSE_NOW") extract();
});

if (document.readyState === "complete") extract();
else window.addEventListener("load", extract, { once: true });

// content.js — extract metadata & talk to page-bridge.js

function getMeta(selector) {
  const el = document.querySelector(selector);
  return el ? el.getAttribute("content") || "" : "";
}

// ---------- extract tab payload ----------
async function extract() {
  const fullText = (document.body?.innerText || "").slice(0, 50000);
  const payload = {
    url: location.href,
    domain: location.hostname.replace(/^www\./, ""),
    title:
      getMeta('meta[property="og:title"]') ||
      getMeta('meta[name="twitter:title"]') ||
      document.title ||
      "",
    favicon: (document.querySelector('link[rel~="icon"]') || {}).href || "",
    heroImage:
      getMeta('meta[property="og:image"]') ||
      getMeta('meta[name="twitter:image"]') ||
      "",
    description:
      getMeta('meta[name="description"]') ||
      getMeta('meta[property="og:description"]') ||
      getMeta('meta[name="twitter:description"]') ||
      "",
    fullText,
  };

  chrome.runtime.sendMessage({ type: "TAB_CONTENT", payload }).catch(() => {});

  // also try summarization if enough text
  if (fullText && fullText.length > 120) {
    maybeSummarize(fullText);
  }
}

// ---------- bridge injection ----------
function injectPageBridge() {
  return new Promise((resolve, reject) => {
    if (document.documentElement.dataset.tabfeedBridgeInjected === "1") {
      return resolve(true);
    }
    chrome.runtime.sendMessage({ type: "INJECT_BRIDGE" }, (resp) => {
      if (resp && resp.ok) {
        document.documentElement.dataset.tabfeedBridgeInjected = "1";
        resolve(true);
      } else {
        reject(resp?.error || "inject-failed");
      }
    });
  });
}

function pingPageBridge() {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    function onMsg(ev) {
      const d = ev.data;
      if (!d || d.__tabfeed !== "SUMMARIZE_PONG" || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      resolve(true);
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ __tabfeed: "SUMMARIZE_PING", id }, "*");
    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve(false);
    }, 3000);
  });
}

function summarizeInPage(text, lang) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    function onMsg(ev) {
      const d = ev.data;
      if (!d || d.__tabfeed !== "SUMMARIZE_RES" || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      resolve(d);
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ __tabfeed: "SUMMARIZE_REQ", id, text, lang }, "*");
    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "timeout" });
    }, 22000); // match bridge timeout
  });
}

// ---------- summarization orchestrator ----------
async function maybeSummarize(fullText) {
  if (!fullText || fullText.length < 120) return;

  try {
    await injectPageBridge();
    const ready = await pingPageBridge();
    if (!ready) {
      console.warn("[TabFeed][content] bridge not ready");
      return;
    }

    const lang = (navigator.language || "en").slice(0, 2);
    const res = await summarizeInPage(fullText.slice(0, 8000), lang);

    if (res && res.ok && res.summary) {
      await chrome.runtime.sendMessage({
        type: "TAB_SUMMARY",
        summary: res.summary,
      }).catch(() => {});
    } else {
      console.warn("[TabFeed][content] summarize failed:", res?.error);
    }
  } catch (e) {
    console.warn("[TabFeed][content] maybeSummarize error:", e);
  }
}

// ---------- wire up ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PARSE_NOW" || msg?.type === "REQUEST_SUMMARY") {
    extract();
  }
});

if (document.readyState === "complete") {
  extract();
} else {
  window.addEventListener("load", extract, { once: true });
}

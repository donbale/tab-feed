// content.js — extract metadata + text; panel handles summarization

function getMeta(selector) {
  const el = document.querySelector(selector);
  return el ? el.getAttribute("content") || "" : "";
}

async function extract() {
  const fullText = (document.body?.innerText || "").slice(0, 50000);
  const payload = {
    url: location.href,
    domain: location.hostname.replace(/^www\./, ""),
    title:
      getMeta('meta[property="og:title"]') ||
      getMeta('meta[name="twitter:title"]') ||
      document.title || "",
    favicon: (document.querySelector('link[rel~="icon"]') || {}).href || "",
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

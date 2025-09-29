// Extract a few safe/cheap fields from the page.
// (No external scripts; MV3 blocks remote code in content scripts.)
function getMeta(selector) {
  const el = document.querySelector(selector);
  return el ? el.getAttribute("content") || "" : "";
}

function extract() {
  const payload = {
    url: location.href,
    domain: location.hostname.replace(/^www\./, ""),
    title:
      getMeta('meta[property="og:title"]') ||
      getMeta('meta[name="twitter:title"]') ||
      document.title ||
      "",
    favicon:
      (document.querySelector('link[rel~="icon"]') || {}).href || "",
    heroImage:
      getMeta('meta[property="og:image"]') ||
      getMeta('meta[name="twitter:image"]') ||
      "",
    description:
      getMeta('meta[name="description"]') ||
      getMeta('meta[property="og:description"]') ||
      getMeta('meta[name="twitter:description"]') ||
      ""
  };

  chrome.runtime.sendMessage({ type: "TAB_CONTENT", payload }).catch(() => {});
}

// Re-run on demand from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PARSE_NOW") extract();
});

// Run once when idle/loaded
if (document.readyState === "complete") extract();
else window.addEventListener("load", () => extract(), { once: true });

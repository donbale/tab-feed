// page-bridge.js — injected into PAGE world via chrome.scripting (world: "MAIN")
// Now with hard timeouts so the content script never hangs on "Generating…"

(function () {
  const OK_LANGS = new Set(["en", "es", "ja"]);

  function pickLang(raw) {
    const l = (raw || "en").slice(0, 2).toLowerCase();
    return OK_LANGS.has(l) ? l : "en";
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label || "timeout")), ms)),
    ]);
  }

  async function getCaps(API) {
    try {
      if (typeof API.capabilities === "function") {
        return await withTimeout(API.capabilities(), 3000, "caps-timeout");
      }
      if (typeof API.availability === "function") {
        return await withTimeout(API.availability(), 3000, "caps-timeout");
      }
    } catch (e) {
      return { available: "no", error: String(e) };
    }
    return { available: "no" };
  }

  async function ensureSummarizer(lang) {
    const API = globalThis.Summarizer || (globalThis.ai && globalThis.ai.summarizer);
    if (!API) return { ok: false, error: "no-api" };

    const caps = await getCaps(API);
    if (!caps || caps.available === "no") return { ok: false, error: caps?.available || "no" };

    try {
      // Some builds reject format at create time; pass only length & output
      const inst = await withTimeout(
        API.create({ type: "key-points", length: "short", output: { language: lang } }),
        8000,
        "create-timeout"
      );
      return { ok: true, inst };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // Respond to handshake (panel/content ping)
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d && d.__tabfeed === "SUMMARIZE_PING") {
      window.postMessage({ __tabfeed: "SUMMARIZE_PONG", id: d.id, ok: true }, "*");
    }
  });

  // Main summarize handler with hard timeouts
  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || d.__tabfeed !== "SUMMARIZE_REQ") return;

    try {
      const lang = pickLang(d.lang);
      const { ok, inst, error } = await ensureSummarizer(lang);
      if (!ok || !inst) {
        window.postMessage({ __tabfeed: "SUMMARIZE_RES", id: d.id, ok: false, error }, "*");
        return;
      }

      const input = (d.text || "").slice(0, 8000);
      if (input.length < 60) {
        window.postMessage({ __tabfeed: "SUMMARIZE_RES", id: d.id, ok: false, error: "too-short" }, "*");
        return;
      }

      const out = await withTimeout(
        inst.summarize(input, { format: "markdown", output: { language: lang } }),
        15000, // 15s summarize timeout
        "summarize-timeout"
      );

      const summary = typeof out === "string" ? out : (out && out.summary) || "";
      window.postMessage({ __tabfeed: "SUMMARIZE_RES", id: d.id, ok: true, summary }, "*");
    } catch (e) {
      window.postMessage(
        { __tabfeed: "SUMMARIZE_RES", id: d.id, ok: false, error: String(e && e.message ? e.message : e) },
        "*"
      );
    }
  });
})();

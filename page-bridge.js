// page-bridge.js  (MAIN world)
// --- boot ping so content.js knows we're alive ASAP
window.postMessage({ __tabfeed: "BRIDGE_READY" }, "*");

(function () {
  const OK = new Set(["en","es","ja"]);
  const pick = l => (l = (l||"en").slice(0,2).toLowerCase(), OK.has(l) ? l : "en");

  let instance = null;    // singleton
  let creating = null;

  function withTimeout(p, ms, label="timeout") {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms))
    ]);
  }

  async function getAPI() {
    // Prefer window.Summarizer if present, else ai.summarizer
    return globalThis.Summarizer || (globalThis.ai && globalThis.ai.summarizer) || null;
  }

  async function ensureInstance(lang) {
    const API = await getAPI();
    if (!API) return { ok:false, error:"no-api" };

    try {
      const caps = API.capabilities ? await withTimeout(API.capabilities(), 2500, "caps-timeout")
                                    : await withTimeout(API.availability(), 2500, "caps-timeout");
      if (!caps || caps.available === "no") return { ok:false, error:"no" };
    } catch (e) {
      return { ok:false, error:"caps-failed" };
    }

    if (instance) return { ok:true, inst: instance };
    if (creating)  return creating;

    creating = (async () => {
      try {
        // Keep create() minimal (some builds reject format here)
        instance = await withTimeout(
          API.create({ type:"key-points", length:"short", output:{ language: lang } }),
          6000, "create-timeout"
        );
        return { ok:true, inst: instance };
      } catch (e) {
        instance = null;
        return { ok:false, error: String(e && e.message ? e.message : e) };
      } finally {
        creating = null;
      }
    })();

    return creating;
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d && d.__tabfeed === "SUMMARIZE_PING") {
      window.postMessage({ __tabfeed: "SUMMARIZE_PONG", id: d.id, ok: true }, "*");
    }
  });

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || d.__tabfeed !== "SUMMARIZE_REQ") return;

    const lang = pick(d.lang);
    const text = (d.text || "").slice(0, 4000); // smaller chunk = faster/stabler
    if (text.length < 80) {
      window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:false, error:"too-short" }, "*");
      return;
    }

    try {
      const { ok, inst, error } = await ensureInstance(lang);
      if (!ok || !inst) {
        window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:false, error }, "*");
        return;
      }

      const out = await withTimeout(
        inst.summarize(text, { format:"markdown", output:{ language: lang } }),
        10000, "summarize-timeout"
      );

      const summary = typeof out === "string" ? out : (out?.summary || "");
      window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:true, summary }, "*");
    } catch (e) {
      window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:false, error:String(e) }, "*");
    }
  });
})();

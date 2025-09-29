(function () {
  function pickLang(raw) {
    const l = (raw || "en").slice(0, 2).toLowerCase();
    return (l === "en" || l === "es" || l === "ja") ? l : "en";
  }

  async function caps(API) {
    return API.capabilities ? API.capabilities()
         : (API.availability ? API.availability() : { available: "no" });
  }

  async function ensureSummarizer(lang) {
    const API = globalThis.Summarizer || (globalThis.ai && globalThis.ai.summarizer);
    if (!API) return { ok: false, error: "no-api" };
    const c = await caps(API);
    if (!c || c.available === "no") return { ok: false, error: c?.available || "no" };
    try {
      // no 'format' here — some builds reject it at create()
      const inst = await API.create({ type: "key-points", length: "short", output: { language: lang } });
      return { ok: true, inst };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d) return;

    if (d.__tabfeed === "SUMMARIZE_PING") {
        window.postMessage({ __tabfeed: "SUMMARIZE_PONG", id: d.id, ok: true }, "*");
        return;
    }
    if (d.__tabfeed !== "SUMMARIZE_REQ") return;

    try {
        const API = globalThis.Summarizer || (globalThis.ai && globalThis.ai.summarizer);
        if (!API) { window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:false, error:"no-api" },"*"); return; }
        const caps = API.capabilities ? await API.capabilities() : await API.availability?.();
        if (!caps || caps.available === "no") { window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:false, error:caps?.available||"no" },"*"); return; }

        const lang = (d.lang || "en").slice(0,2).toLowerCase();
        const inst = await API.create({ type:"key-points", length:"short", output:{ language: (lang==="es"||lang==="ja")?lang:"en" } });

        const text = (d.text || "").slice(0, 8000);
        const out = await inst.summarize(text, { format:"markdown", output:{ language:(lang==="es"||lang==="ja")?lang:"en" } });
        const summary = typeof out === "string" ? out : (out?.summary || "");
        window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:true, summary }, "*");
    } catch (e) {
        window.postMessage({ __tabfeed:"SUMMARIZE_RES", id:d.id, ok:false, error:String(e) }, "*");
    }
    });
})();

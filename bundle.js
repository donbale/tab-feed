async function hydrate() {
  const urlParams = new URLSearchParams(window.location.search);
  const bundleId = urlParams.get("id");

  if (bundleId) {
    const { bundle, tabs } = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_BUNDLE", id: bundleId }, resolve);
    });

    if (bundle && tabs) {
      document.getElementById("bTitle").textContent = bundle.title;
      document.getElementById("bMeta").textContent = `${bundle.tabIds.length} tabs`;
      const summaryEl = document.getElementById("bSummary");
      summaryEl.innerHTML = bundle.summary ? renderMarkdown(bundle.summary) : "Generating summary...";
      
      const tipsContainer = document.getElementById("bTips");
      tipsContainer.innerHTML = "";
      if (bundle.tips && bundle.tips.length) {
        for (const tip of bundle.tips) {
          if (tip && typeof tip === "object" && tip.url) {
            const a = document.createElement("a");
            a.className = "chip";
            a.href = tip.url;
            a.target = "_blank";
            a.rel = "noreferrer";
            a.textContent = tip.label || tip.text || tip.url;
            tipsContainer.appendChild(a);
          } else {
            const tipElement = document.createElement("div");
            tipElement.className = "chip";
            tipElement.textContent = String(tip);
            tipsContainer.appendChild(tipElement);
          }
        }
      } else {
        tipsContainer.textContent = "Generating tips...";
      }

      const tabsContainer = document.getElementById("bTabs");
      tabsContainer.innerHTML = "";
      for (const tab of tabs) {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";

        const tabLink = document.createElement("a");
        tabLink.className = "tab-link";
        tabLink.href = tab.url;
        tabLink.target = "_blank";

        const favicon = document.createElement("img");
        favicon.src = tab.favicon || "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
        favicon.className = "favicon";

        const title = document.createElement("span");
        title.textContent = tab.title;

        tabLink.appendChild(favicon);
        tabLink.appendChild(title);

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "Remove";
        removeBtn.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          removeBtn.disabled = true;
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "REMOVE_TAB_FROM_BUNDLE", id: bundle.id, tabId: tab.tabId, url: tab.url }, resolve);
          });
          hydrate();
        };

        row.appendChild(tabLink);
        row.appendChild(removeBtn);
        tabsContainer.appendChild(row);
      }

      const askButton = document.getElementById("askBtn");
      const askInput = document.getElementById("ask");
      const answerDiv = document.getElementById("answer");
      const chatLog = document.getElementById("chatLog");

      // Prevent multiple listeners by using direct assignment
      askButton.onclick = async () => {
        const question = (askInput.value || "").trim();
        if (!question) return;
        askButton.disabled = true;
        answerDiv.textContent = "Thinking…";
        const { answer } = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "ASK_QUESTION", question, bundle }, resolve);
        });
        answerDiv.innerHTML = renderMarkdown(answer || "");
        askButton.disabled = false;
        // Re-hydrate to show chat history
        hydrate();
      };

      // Submit on Enter
      if (askInput) {
        askInput.onkeydown = (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            askButton.click();
          }
        };
      }

      // Render chat history with Markdown
      chatLog.innerHTML = "";
      if (Array.isArray(bundle.chat) && bundle.chat.length) {
        for (const entry of bundle.chat.slice(-10)) { // show last 10
          const wrap = document.createElement("div");
          wrap.style.marginTop = "8px";

          const qLabel = document.createElement("div");
          qLabel.className = "meta";
          qLabel.textContent = "Q:";
          const qBody = document.createElement("div");
          qBody.className = "summary";
          qBody.innerHTML = renderMarkdown(entry.question || "");

          const aLabel = document.createElement("div");
          aLabel.className = "meta";
          aLabel.textContent = "A:";
          const aBody = document.createElement("div");
          aBody.className = "summary";
          aBody.innerHTML = renderMarkdown(entry.answer || "");

          wrap.appendChild(qLabel);
          wrap.appendChild(qBody);
          wrap.appendChild(aLabel);
          wrap.appendChild(aBody);
          chatLog.appendChild(wrap);
        }
      }

      // Wire Save & Close Tabs
      const saveBtn = document.getElementById("saveClose");
      if (saveBtn) {
        saveBtn.onclick = async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = "Saving…";
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "SAVE_BUNDLE_AND_CLOSE", id: bundle.id }, resolve);
          });
          saveBtn.textContent = res && res.ok ? "Saved" : "Save failed";
          // Refresh view to reflect closed tabs and saved snapshot
          setTimeout(hydrate, 400);
        };
      }

      // If summary/tips missing, try generating in-page using window.ai
      if (!bundle.summary || !(bundle.tips && bundle.tips.length)) {
        tryGenerateBundleSummaryAndTips(bundle, tabs, summaryEl, tipsContainer);
      }

      // Re-summarize button
      const reBtn = document.getElementById("reSmz");
      if (reBtn) {
        reBtn.onclick = () => tryGenerateBundleSummaryAndTips(bundle, tabs, summaryEl, tipsContainer, { force: true });
      }

      // Delete bundle with confirmation
      const delBtn = document.getElementById("del");
      if (delBtn) {
        delBtn.onclick = async () => {
          const ok = window.confirm("Are you sure you want to delete this bundle? This cannot be undone.");
          if (!ok) return;
          delBtn.disabled = true;
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "DELETE_BUNDLE", id: bundle.id }, resolve);
          });
          if (res && res.ok) {
            window.location.href = "panel.html";
          } else {
            delBtn.disabled = false;
            delBtn.textContent = "Delete failed";
            setTimeout(() => { delBtn.textContent = "Delete"; }, 1200);
          }
        };
      }

      // ---- Add tabs: show open tabs not already in this bundle ----
      const addList = document.getElementById("addTabs");
      const addSearch = document.getElementById("addSearch");
      if (addList) {
        const swNow = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "GET_TABS_NOW" }, resolve);
        });
        const all = (swNow && Array.isArray(swNow.tabs)) ? swNow.tabs : ((await chrome.storage.local.get(["tabs"]))?.tabs || []);
        const inBundleIds = new Set(bundle.tabIds || []);
        const inBundleUrls = new Set((bundle.items || []).map(i => i.url));
        let candidates = all.filter(t => !inBundleIds.has(t.tabId) && !inBundleUrls.has(t.url));

        const renderAddList = () => {
          const q = (addSearch?.value || "").toLowerCase();
          addList.innerHTML = "";
          const rows = candidates.filter(t => !q || (t.title||"").toLowerCase().includes(q) || (t.domain||"").toLowerCase().includes(q));
          rows.slice(0, 50).forEach(t => {
            const row = document.createElement("div");
            row.style.display = "flex"; row.style.alignItems = "center"; row.style.gap = "8px";
            const fav = document.createElement("img"); fav.src = t.favicon || ""; fav.className = "favicon";
            const title = document.createElement("span"); title.textContent = t.title || t.url;
            const addBtn = document.createElement("button"); addBtn.textContent = "Add";
            addBtn.onclick = async () => {
              addBtn.disabled = true;
              await new Promise((resolve) => {
                chrome.runtime.sendMessage({ type: "ADD_TAB_TO_BUNDLE", id: bundle.id, tabId: t.tabId }, resolve);
              });
              hydrate();
            };
            row.appendChild(fav); row.appendChild(title); row.appendChild(addBtn);
            addList.appendChild(row);
          });
          if (!rows.length) {
            const empty = document.createElement("div");
            empty.className = "meta"; empty.textContent = q ? "No matches" : "No more open tabs to add";
            addList.appendChild(empty);
          }
        };
        renderAddList();
        if (addSearch) addSearch.oninput = renderAddList;
      }
    }
  }
}

async function getLMPage() {
  try {
    const LM = globalThis.LanguageModel || (globalThis.ai && globalThis.ai.languageModel);
    if (!LM) return null;
    const session = await LM.create?.({
      expectedInputs:  [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    });
    return session || null;
  } catch (_) {
    return null;
  }
}

async function tryGenerateBundleSummaryAndTips(bundle, tabs, summaryEl, tipsContainer, opts = {}) {
  const lm = await getLMPage();
  if (!lm) return; // No on-page LM available

  const context = (tabs || []).map(t => `Title: ${t.title}\nURL: ${t.url}\nSummary: ${t.summary || ""}\nText: ${(t.fullText||"").slice(0,300)}`).join("\n---\n");
  if (!context || context.length < 60 && !opts.force) return;

  try {
    summaryEl.textContent = "Generating summary…";
    tipsContainer.textContent = "Generating tips…";

    const subject = (bundle.title || "").trim() || (tabs?.[0]?.title || "");
    const summaryPrompt = `Summarize the following content from a bundle of tabs in 4-6 bullet points.\n${context}`;
    const tipsPrompt = `You are a proactive research assistant. Given the topic: "${subject}", suggest 4-6 ACTIONABLE next steps the user can take to explore the topic further. Each tip MUST be an object with a short label and a URL to a relevant search or well-known site. Output STRICT JSON array, no commentary. Schema: [{"label":string, "url":string}].

Guidelines:
- Prefer links that help the user continue research, not summaries of current tabs.
- Use general-purpose destinations: Google search, Google News, Wikipedia, Reddit, YouTube. If the topic looks like a place/trip, include a TripAdvisor search for top attractions.
- Examples of labels: "Find background on <topic>", "Latest news on <topic>", "Reddit discussions", "YouTube explainers", "Top attractions in <place>".
- Use appropriate queries with the topic in the URL.
Topic context from tabs (for additional cues):\n${context.slice(0, 1200)}`;

    const summary = await lm.prompt([{ role: "user", content: summaryPrompt }]);
    const tipsResp = await lm.prompt([{ role: "user", content: tipsPrompt }]);
    let tips;
    try {
      const jsonString = String(tipsResp).replace(/```json\n?|```/g, "");
      const arr = JSON.parse(jsonString);
      if (Array.isArray(arr)) {
        tips = arr
          .map(x => ({ label: String(x.label||x.text||"Learn more"), url: String(x.url||"") }))
          .filter(x => x.url.startsWith("http"))
          .slice(0, 6);
      }
    } catch {}
    if (!Array.isArray(tips) || !tips.length) {
      tips = buildDeterministicTips(subject);
    }

    // Update UI
    summaryEl.innerHTML = renderMarkdown(summary);
    tipsContainer.innerHTML = "";
    tips.forEach(t => {
      if (t && typeof t === "object" && t.url) {
        const el = document.createElement("a");
        el.className = "chip"; el.href = t.url; el.target = "_blank"; el.rel = "noreferrer"; el.textContent = t.label || t.url; tipsContainer.appendChild(el);
      } else {
        const el = document.createElement("div"); el.className = "chip"; el.textContent = String(t); tipsContainer.appendChild(el);
      }
    });

    // Persist into bundle
    chrome.runtime.sendMessage({ type: "UPDATE_BUNDLE_META", id: bundle.id, summary, tips }).catch(()=>{});
  } catch (_) {
    // leave as-is on error
  }
}

function buildDeterministicTips(subjectRaw="") {
  const subject = subjectRaw.trim() || "this topic";
  const enc = encodeURIComponent;
  const out = [
    { label: `Find background on ${subject}`, url: `https://www.google.com/search?q=${enc(subject)}` },
    { label: `Latest news on ${subject}`, url: `https://www.google.com/search?q=${enc(subject)}&tbm=nws` },
    { label: `Wikipedia overview`, url: `https://en.wikipedia.org/wiki/Special:Search?search=${enc(subject)}` },
    { label: `Reddit discussions`, url: `https://www.reddit.com/search/?q=${enc(subject)}` },
    { label: `YouTube explainers`, url: `https://www.youtube.com/results?search_query=${enc(subject)}` }
  ];
  // Always helpful travel angle; harmless for non-travel topics
  out.push({ label: `Top attractions in ${subject}`, url: `https://www.tripadvisor.com/Search?q=${enc('top attractions ' + subject)}` });
  return out;
}

// ---- Minimal, safe Markdown renderer for summaries ----
function renderMarkdown(md = "") {
  // Escape HTML first
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Linkify [text](url) for http(s) only
  const linkify = (s) => s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, text, url) => {
    return `<a href="${url}" target="_blank" rel="noreferrer">${esc(text)}</a>`;
  });

  // Inline formatting: bold, italics, code
  const inline = (s) => linkify(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(?!\s)([^*]+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = String(md || "").split(/\r?\n/);
  let html = '';
  let inUL = false, inOL = false;
  const closeLists = () => {
    if (inUL) { html += '</ul>'; inUL = false; }
    if (inOL) { html += '</ol>'; inOL = false; }
  };

  for (let raw of lines) {
    const l = raw.trim();
    if (!l) { closeLists(); continue; }
    let m;
    if ((m = l.match(/^[-*]\s+(.+)/))) {
      if (!inUL) { closeLists(); html += '<ul>'; inUL = true; }
      html += `<li>${inline(esc(m[1]))}</li>`;
      continue;
    }
    if ((m = l.match(/^\d+[.)]\s+(.+)/))) {
      if (!inOL) { closeLists(); html += '<ol>'; inOL = true; }
      html += `<li>${inline(esc(m[1]))}</li>`;
      continue;
    }
    // Headings ###, ##, #
    if ((m = l.match(/^###\s+(.+)/))) { closeLists(); html += `<h3>${inline(esc(m[1]))}</h3>`; continue; }
    if ((m = l.match(/^##\s+(.+)/)))  { closeLists(); html += `<h2>${inline(esc(m[1]))}</h2>`;  continue; }
    if ((m = l.match(/^#\s+(.+)/)))   { closeLists(); html += `<h1>${inline(esc(m[1]))}</h1>`;   continue; }
    // Paragraph
    closeLists();
    html += `<p>${inline(esc(l))}</p>`;
  }
  closeLists();
  return html || esc(md);
}

document.addEventListener("DOMContentLoaded", hydrate);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TABS_UPDATED") {
    hydrate();
  }
});

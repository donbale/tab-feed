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
      document.getElementById("bSummary").textContent = bundle.summary || "Generating summary...";
      
      const tipsContainer = document.getElementById("bTips");
      tipsContainer.innerHTML = "";
      if (bundle.tips && bundle.tips.length) {
        for (const tip of bundle.tips) {
          const tipElement = document.createElement("div");
          tipElement.className = "chip";
          tipElement.textContent = tip;
          tipsContainer.appendChild(tipElement);
        }
      } else {
        tipsContainer.textContent = "Generating tips...";
      }

      const tabsContainer = document.getElementById("bTabs");
      tabsContainer.innerHTML = "";
      for (const tab of tabs) {
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
        tabsContainer.appendChild(tabLink);
      }

      const askButton = document.getElementById("askBtn");
      const askInput = document.getElementById("ask");
      const answerDiv = document.getElementById("answer");

      askButton.addEventListener("click", async () => {
        const question = askInput.value;
        if (question) {
          answerDiv.textContent = "Thinking…";
          const { answer } = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "ASK_QUESTION", question, bundle }, resolve);
          });
          answerDiv.textContent = answer;
        }
      });
    }
  }
}

document.addEventListener("DOMContentLoaded", hydrate);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TABS_UPDATED") {
    hydrate();
  }
});
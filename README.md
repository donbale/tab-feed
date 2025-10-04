# TabFeed POC

A Chrome side-panel extension that shows all your open tabs as cards, complete with titles, favicons/hero images, metadata, and live summaries (via Chrome's experimental Summarizer API).

---

## 🚀 How to run it

1. **Clone the repo**

   ```bash
   git clone <this-repo>
   cd tab-feed
   ```

2. **Open Extensions Page**

   * Go to `chrome://extensions`
   * Toggle **Developer mode** (top right)

3. **Load Unpacked Extension**

   * Click **Load unpacked**
   * Select the `tab-feed` folder

4. **Try it out**

   * Open some news/dev pages in tabs
   * Open the Side panel (puzzle piece → *Tab Feed (POC)* or right edge side-panel icon)
   * You’ll see your tabs show up as cards and live-update when you open/close or navigate.

---

## 📝 Summarizer API Setup

The Chrome **On-Device Summarizer API** is still experimental. To get it working in TabFeed, a few manual steps are required:

### 1. Enable the Summarizer API in Chrome Flags

Open the following URL in Chrome:

```
chrome://flags/#summarization-api-for-desktop
```

* Set **Summarization API for Desktop** → **Enabled**
* Restart Chrome.

You may also need to ensure the **Experimental Web Platform features** flag is enabled:

```
chrome://flags/#enable-experimental-web-platform-features
```

### 2. Verify the On-Device Model

Chrome uses an on-device foundation model (v3Nano) for summarization.
To confirm the model is downloaded and ready:

1. Go to:

   ```
   chrome://on-device-internals/
   ```
2. Under **Foundational Model**, check that:

   * `Foundational model state` is **Ready**
   * The model path is visible (e.g. `.../OptGuideOnDeviceModel/...`)
   * Crash count is `0/3`.

### 3. Supported Output Languages

At the moment, Chrome’s Summarizer API requires specifying an output language. Supported codes are:

* `en` — English
* `es` — Spanish
* `ja` — Japanese

If no language is passed, summarization requests may fail with an error.

### 4. Debugging

* Use **DevTools > Console** in either the service worker (`background.js`) or the panel to check logs.
* Look for messages like:

  * `caps: available` → Summarizer API is exposed.
  * `summary:` → Summary result received.
  * `[TL;DR error: ...]` → Something failed; check the error reason.

# Tab Feed

A Chrome side‑panel extension that organizes your open tabs into a clean, actionable dashboard. It shows tab cards with titles, favicons/hero images, summaries, entities, and categories. Create bundles, ask questions about them, and save your work by snapshotting bundles and closing the originals — all on your device.

---

## How to run

1. Clone the repo

   git clone <this-repo>
   cd tab-feed

2. Open Extensions page
- Go to chrome://extensions
- Toggle Developer mode (top right)

3. Load Unpacked
- Click “Load unpacked”
- Select this repository folder

4. Try it out
- Open some pages in tabs
- Click the toolbar icon or open the Side Panel
- Tabs appear as cards and live‑update as you browse

---

## On‑device AI (Summarizer)
The on‑device Summarizer API is experimental. To enable it:

1) Enable the Summarization flag
- Navigate to chrome://flags/#summarization-api-for-desktop
- Set to Enabled and restart Chrome

2) (If needed) Enable Experimental Web Platform features
- chrome://flags/#enable-experimental-web-platform-features

3) Verify model is ready
- chrome://on-device-internals (Foundational Model should be “Ready”)

If the API is unavailable, features gracefully degrade (e.g., actionable tips fall back to deterministic links).

---

## Features
- Side‑panel dashboard with tab cards, summaries, entities, and categories
- Bundles: create, view, add/remove tabs, delete with confirmation
- Save & Close Tabs: snapshot links, summaries, and details, then close originals
- Bundle Q&A: ask questions about a bundle; chat history saved per bundle
- Actionable tips: “Find background,” “Latest news,” “Wikipedia,” “Reddit,” “YouTube,” “TripAdvisor” links
- Markdown rendering for summaries, answers, and chat history
- Tab Age stats: counts for tabs older than 7/14/30 days
- Compact, Google‑style UI and icons

---

## Packaging for the Chrome Web Store
1) Bump version in manifest.json (currently 0.1.0).
2) Zip the repository contents (exclude .git) and upload via the Developer Dashboard.
3) Use the Store Listing Snippet below for your listing text, and add screenshots.

### Permissions and Privacy
This extension works locally and stores state in chrome.storage.local. It does not transmit browsing data to remote servers.

Requested permissions are used for visible features:
- tabs, tabGroups: enumerate and manage tab metadata and actions
- scripting: inject content script to extract page text for summaries
- storage: persist local state (tabs, bundles, summaries)
- history: compute “first opened” times via earliest visit
- webRequest (non‑blocking): aggregate counts for session stats
- contentSettings: optionally show mic/camera allowances in the rail
- system.memory: coarse memory estimate for the session

See PRIVACY.md for full details.

---

## Store Listing Snippet

Short description
- Organize your tabs with on‑device AI: summarize pages, group into bundles, and save & close when you’re done — without sending data off your device.

Long description
- Tab Feed is a side‑panel dashboard for your open tabs. It extracts page text locally to generate TL;DR summaries, entities, and categories. Create bundles for related work, add/remove tabs, ask questions about the bundle, and save your progress by snapshotting the bundle (links + summaries) and closing the originals.
- Tips are actionable links to continue research (Google, News, Wikipedia, Reddit, YouTube, TripAdvisor). The rail shows “Tab Age” counters (older than 7/14/30 days), quick categories, and basic session stats.
- Privacy: Tab Feed runs locally and stores data in chrome.storage.local. No data is transmitted to remote servers. See PRIVACY.md for details.

Screenshots (suggested)
- Side panel dashboard with tab cards and summaries
- Bundle view with Save & Close Tabs and Q&A
- Tab Age stats in the rail

---

## Icons
Place icons in icons/ (16/32/48/128). The toolbar and page favicons are wired in manifest.json, panel.html, and bundle.html.


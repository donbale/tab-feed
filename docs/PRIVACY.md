# Privacy Policy – Tab Feed

Last updated: 2025-10-16

Tab Feed is a local, side‑panel extension that organizes your open tabs and helps you summarize content using on‑device browser APIs. We designed it to operate entirely on your device.

## Data Collection
- We do not collect, transmit, sell, or share any personal data.
- The extension does not send your browsing data to any server controlled by us or third parties.

## What the Extension Accesses Locally
- Open tab metadata: title, URL, favicon, domain, pin/audible state, and reading‑time estimate.
- Page text for tabs where you allow the content script to run, so the extension can generate summaries, entities, and categories.
- Visit times for a tab’s URL from the browser History API (to show how long a tab has been open).
- Network request counts (non‑blocking) per tab to display high‑level session stats such as “tabs with trackers” or “third‑party requests.”

All of this access is used only for features presented in the UI.

## Storage
- The extension stores data locally using `chrome.storage.local` (on your device), including:
  - The current list of open tabs and derived metadata (summaries, entities, categories).
  - User‑created bundles (including saved snapshots of tab content when you choose “Save & Close Tabs”).
  - Optional chat history tied to a bundle (your questions and the model’s answers).
  - Lightweight session stats and age information used to power the rail cards.

Nothing is uploaded to external services by the extension.

## AI Usage
- Summaries and tips are generated using browser‑provided on‑device models when available (e.g., `window.ai`). Where not available, features may be disabled or fall back to simple local heuristics. No content is sent to remote AI services by this extension.

## Permissions Rationale
- `tabs`: enumerate open tabs and manage pin/focus/close.
- `scripting`: inject the content script on pages you visit to extract article text (when permitted by the page).
- `storage`: persist local state (tabs, bundles, summaries, settings).
- `history`: compute “first opened” times for tabs more accurately by checking earliest visit.
- `webRequest` (non‑blocking): aggregate high‑level request counts for session stats (no request is blocked or modified).
- `contentSettings`: optionally show mic/camera allowance flags for the current tab’s site.

If you prefer to reduce permissions, you may fork and remove certain features (e.g., request statistics or mic/camera flags) and the corresponding permissions.

## Third‑Party Sharing
We do not share any data with third parties.

## Security
- Data is stored locally using browser storage APIs.
- The extension does not inject or load remote code. All assets ship with the extension.

## Contact
If you have questions or requests regarding privacy, please open an issue in this repository.


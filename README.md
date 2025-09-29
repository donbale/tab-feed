# Tab Feed (POC)

This is a simple proof-of-concept Chrome extension that turns your open tabs into a live feed. It extracts metadata (title, URL, favicon, description, hero image) and displays them in a clean card-based interface that updates as you open, close, or navigate tabs.

## How to run it

1. **Clone the repo**

   ```bash
   git clone <your-repo-url>
   cd tab-feed
   ```

2. **Enable Developer Mode in Chrome**

   * Open `chrome://extensions`
   * Toggle **Developer mode** (top right)

3. **Load the extension**

   * Click **Load unpacked**
   * Select the `tab-feed` folder

4. **Open some tabs**

   * Navigate to a few news/dev pages (BBC, Guardian, Reddit, HN, etc.)

5. **Open the side panel**

   * Click the puzzle piece icon → “Tab Feed (POC)”
   * Or use the side panel icon on the right edge

6. **See the feed in action**

   * Your open tabs will show up as cards
   * The feed live-updates as you open, close, or navigate tabs

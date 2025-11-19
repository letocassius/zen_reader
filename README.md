# Zen Reader (Chrome Extension)

Zen Reader gives any article a pared-down, Safari-style view inside a lightweight MV3 Chrome extension. It leans on a custom heuristic plus Mozilla’s Readability fallback to isolate the primary story, wraps it in a distraction-free overlay, and remembers the theme and typography you last used via `chrome.storage`.

## Features
- **One-click reading view** – the toolbar button toggles an overlay on the active tab without reloading the page.
- **Robust extraction** – scores article containers, falls back to Readability, and finally to paragraph sampling so most sites render something usable.
- **Theme & typography controls** – four themes, adjustable font size/line height/max width, and font selection (with sensible fallbacks for Latin and CJK scripts).
- **Per-device preferences** – the most recent theme/size are saved locally, so your preferred look sticks on every page.
- **MV3-ready** – background service worker, content script, and CSS are wired through the manifest; icons for every Chrome requirement are included.

## Repository layout
- `manifest.json` – Chrome MV3 manifest, permissions, and resource wiring.
- `background.js` – handles the browser action click and sends the `TOGGLE_READER_ACTION` message to the active tab.
- `contentScript.js` – article detection/cleanup, overlay creation, preference storage, and message handling.
- `reader.css` – overlay layout plus the named themes; drop additional fonts in `fonts/` and declare them here if desired.
- `icons/` – 16–256px PNGs plus `icon.svg` source for regenerating sizes.
- `Readability.js` – bundled MPL-licensed Readability extractor (lightly modified).

## Local setup
1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select the repository root.
3. A “Toggle Zen Reader” icon appears in the toolbar; pin it if you want persistent access.

## Usage tips
- Visit any long-form article, then click the toolbar icon to toggle the overlay. Click again (or hit the close button inside the overlay) to restore the original page.
- Use the controls at the top-right of the overlay to change theme, font size, and text alignment; the extension persists the newest values.
- If a site renders poorly, inspect `contentScript.js`’s selectors/skip list or rely on Readability by ensuring it loads the canonical article markup.

## Customize & develop
- Reader appearance lives in `reader.css`; add new theme classes or tweak typography here.
- Extraction heuristics (selectors, scoring, SKIP patterns) live near the top of `contentScript.js`.
- The project does not require a build step. Running `npm install` is unnecessary; simply edit the files and reload the extension via `chrome://extensions`.
- For debugging, open DevTools on the target page, switch to the **Console**, and log from `contentScript.js`; DevTools on `chrome://extensions` shows background worker logs.

## Publish to the Chrome Web Store
1. Ensure the icons defined in `manifest.json` are present (already included).
2. Capture promotional screenshots if you plan to list publicly.
3. From the repo root, produce the upload archive (exclude macOS metadata):
   ```bash
   zip -r zen-reader.zip . -x '*.DS_Store' '*/.DS_Store'
   ```
4. Upload `zen-reader.zip` to the Chrome Web Store Developer Dashboard, fill out the listing details, and submit for review.

## Licensing & MPL compliance
- `Readability.js` is licensed under the Mozilla Public License 2.0. The full MPL text is included in `LICENSE` and must accompany any distribution of this extension.
- Do not delete the existing copyright headers in `Readability.js` (or any other MPL-covered file). Any changes to those files must be shared under MPL-2.0.
- When shipping the extension, make the corresponding Source Code Form publicly accessible—publishing this repository or hosting a zip of the sources alongside your Web Store listing satisfies the requirement.
- Avoid copying MPL-covered code into other files unless you are willing to license those files under MPL-2.0.
- The MPL provides a patent grant for the covered code; it terminates if you initiate a patent claim over that implementation.

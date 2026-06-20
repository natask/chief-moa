## 1. Quiet Headless Harness (must come first)

- [x] 1.1 Locate Chrome for Testing on disk (puppeteer/playwright cache) and resolve its binary path with a clear error if absent.
- [x] 1.2 Launch it `--headless=new` with a temp `--user-data-dir` under `.gstack/background-qa/<run>/chrome-profile` and `--load-extension=extension/`; confirm the agee `service_worker` target appears via the DevTools `/json/list` and capture the extension id.
- [x] 1.3 Verify no window is shown, no focus is taken, and no prompt is raised during the run; never use `open`/`open -a` and never the user's daily profile.
- [x] 1.4 Rewrite `smoke-extension.mjs` to use this headless Chrome for Testing path so it tests the real extension instead of the content-script fallback.

## 2. Background Dev/Reload Loop

- [x] 2.1 Make `dev-extension.mjs` background-friendly: remove/guard the `open -a "Google Chrome"` path; default to no visible window.
- [x] 2.2 Confirm an edit under `extension/` triggers `chrome.runtime.reload()` against the headless instance without a visible window.

## 3. Explicit Visible Path (opt-in only)

- [x] 3.1 Document the manual `chrome://extensions` → Load unpacked route as the only "I want to see it" path, clearly separated from the default quiet flow.

## 4. Verify + Document

- [x] 4.1 Run `npm run verify` and the rewritten `npm run smoke`; smoke reports it exercised the real extension headless (not the harness).
- [x] 4.2 Replace ambiguous load instructions in `README.md` with the one canonical quiet sequence plus the opt-in visible route.

## Why

The agee extension has never been confirmed running on the developer's own
machine, and the existing harness makes development intolerable: it spawns the
user's branded Google Chrome in a visible window that steals mouse/focus, and
branded Chrome also hard-blocks `--load-extension` (`--load-extension is not
allowed in Google Chrome, ignoring`), so smoke silently falls back to a
content-script harness and never tests the real extension.

The non-negotiable first requirement is that development is **quiet**: it runs
headless and off-screen, never grabs focus, never prompts mid-run, and uses a
throwaway profile — never the user's daily Chrome/Brave. The developer is only
pulled in when there is something they must see, and only explicitly.

This is proven feasible: headless **Chrome for Testing** (already on disk via the
puppeteer cache) allows `--load-extension` and loads the real agee service worker
with no visible window.

## What Changes

- Drive a **headless Chrome for Testing** (not branded Chrome) with a temp
  profile under `.gstack/background-qa/`, confirming the real extension's service
  worker loads (stable id) with no window shown and no focus stolen.
- Make the smoke/QA path test the real extension headless instead of falling
  back to the content-script harness.
- Provide a background dev/reload loop that does not call `open`/`open -a` and
  does not surface a window unless the developer explicitly asks to see it.
- Document one canonical, quiet load + bridge sequence; document the manual
  `chrome://extensions` → Load unpacked path only as the explicit "I want to see
  it" route.

## Capabilities

### New Capabilities

- `extension-run-baseline`: A confirmed, quiet, headless way to load and exercise
  the real unpacked extension off-screen, with a temp profile, plus a background
  reload loop — and an explicit, opt-in visible path for manual review.

## Impact

- `browser_extension/scripts/smoke-extension.mjs` (target Chrome for
  Testing, headless, temp profile), `scripts/dev-extension.mjs` (no `open`,
  background by default), `README.md`. Uses the `local-background-qa` posture and
  `.gstack/background-qa/` artifacts.

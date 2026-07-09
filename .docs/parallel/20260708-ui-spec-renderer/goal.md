# Goal: Browser UI Spec Renderer

## Goal

Make `/v1/ui/spec` an actual browser overlay surface so a model or user can
ship voice-generated UI as bounded data instead of Markdown or extension code.

## Target Files

- `gateway/lib/ui-spec.js`
- `gateway/scripts/smoke-ui-spec.js`
- `browser_extension/extension/background.js`
- `browser_extension/extension/content.js`
- `browser_extension/extension/overlay.css`
- `browser_extension/scripts/smoke-ui-spec.mjs`
- `browser_extension/package.json`
- `reference/openspec/changes/extension-ui-self-extension/tasks.md`
- `ARCHITECTURE.md`

## Branch And Worktree

- Branch: `agent/ui-spec-renderer`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/ui-spec-renderer`

## Acceptance Criteria

- Gateway UI spec normalization accepts a bounded component vocabulary:
  `card`, `list`, `map`, and `stat`, in addition to the existing controls.
- The `map` component is declarative data only: center, zoom, optional label,
  and bounded markers.
- Extension background fetches and caches `/v1/ui/spec` through `callGateway`,
  preserving last-good data on failures.
- Content script renders the first known surface above the composer, with
  controls and components styled inside the overlay and refreshed via
  `chrome.storage.onChanged`.
- No code path uses `eval`, `new Function`, remote scripts, or
  `chrome.scripting.executeScript` for UI spec rendering.
- Static smokes prove the gateway and extension behavior.

## Verification Command

```sh
cd gateway && npm run smoke:ui-spec
cd browser_extension && npm run smoke:ui-spec
cd browser_extension && npm run verify
```

## Do Not Touch

- `.env` files or provider credentials.
- Android app files.
- Browser background agent-loop behavior except shared cache/message patterns.
- Active deployment refs or live gateway service.

## Live-App Constraints

The active browser extension may be loaded in the user's browser. Do not reload
it or run active deployment until verification and the active-promotion gate are
proven.

# Peter/Natstack Ledger: UI Spec Renderer

Run id: `20260708-ui-spec-renderer`
Base ref: `691c244`
Orchestrator branch: `agent/ui-spec-renderer`
Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/ui-spec-renderer`

## Scope

Desired outcome: make forward progress on voice-generated, engine-served UI by
turning the existing `/v1/ui/spec` gateway document into a real browser overlay
surface, with bounded known components and no remote executable code.

Non-goals:
- No live gateway promotion or browser reload unless the active-promotion gate
  is proven.
- No generated privileged JavaScript in the extension.
- No Android changes in this slice.
- No provider-key or `.env` reads.

Live-app constraints:
- Treat the active extension and `https://api.agee.app` as live.
- Work only in this isolated worktree until verification is complete.
- Browser extension packaging is a release artifact; active reload requires a
  separate no-interruption gate.

## Slices

Only one implementation lane is used. The useful work touches shared browser
overlay files and the gateway UI schema, so splitting further would create
overlapping ownership.

### Lane 1: Browser UI Spec Renderer

Branch: `agent/ui-spec-renderer`
Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/ui-spec-renderer`
Target files:
- `gateway/lib/ui-spec.js`
- `gateway/scripts/smoke-ui-spec.js`
- `browser_extension/extension/background.js`
- `browser_extension/extension/content.js`
- `browser_extension/extension/overlay.css`
- `browser_extension/scripts/smoke-ui-spec.mjs`
- `browser_extension/package.json`
- `reference/openspec/changes/extension-ui-self-extension/tasks.md`
- `ARCHITECTURE.md`

Acceptance:
- The gateway validates a declarative UI document with known controls and known
  components, including a bounded `map` component.
- The extension background fetches `/v1/ui/spec`, caches the last-good document,
  marks stale cache on refresh failure, and exposes a content-script message.
- The content script renders the engine-served surface in the overlay using
  known DOM/CSS only; generated JS is never executed.
- UI controls can submit known actions back through existing extension behavior.
- Verification commands pass or blockers are recorded.

Verification:
- `cd gateway && npm run smoke:ui-spec`
- `cd browser_extension && npm run smoke:ui-spec`
- `cd browser_extension && npm run verify`

## Events

- Created isolated worktree from `691c244`.
- Scoped to one lane because all implementation files are shared by one browser
  overlay surface.
- Implemented gateway component normalization for `card`, `list`, `stat`, and
  schematic `map` components.
- Implemented extension `/v1/ui/spec` fetch/cache/message path and content-side
  rendering/sanitization for known tier-A controls/components.
- Bumped browser extension manifest from `0.1.28` to `0.1.29`.
- Created browser extension release artifact:
  `browser_extension/dist/A.G.-0.1.29.zip`.
- Verification passed:
  - `cd gateway && npm run smoke:ui-spec`
  - `cd gateway && npm run check`
  - `cd browser_extension && npm run smoke:ui-spec`
  - `cd browser_extension && npm run verify`
  - `cd browser_extension && npm run smoke:self-extension`
  - `openspec validate extension-ui-self-extension --strict`
- Active promotion blocked: this branch is an isolated worktree branch, not
  merged/pushed through the VPS gateway workflow; no separate gateway preview,
  backup/restore evidence, live session drain evidence, or browser
  no-interruption reload evidence was collected. The live gateway and loaded
  extension were not restarted or reloaded.

# Goal: gestures-shortcuts

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Research the user's requested voice-first gestures and keyboard shortcuts across
browser extension and Android, including Chrome extension command constraints:
whether global commands can use comma/dot/slash or must use numbers/function
keys, and how that maps to single, double, triple, hold, and text modes.

## Target Files

Read only:

- `browser_extension/extension/manifest.json`
- `browser_extension/extension/content.js`
- `browser_extension/extension/background.js`
- `browser_extension/extension/offscreen.js`
- `android_app/app/src/main/java/ai/moa/assistant/*`
- `reference/openspec/changes/voice-first-orb-gestures/proposal.md`
- `ARCHITECTURE.md`

## Acceptance Criteria

- Give a source-backed answer for Chrome command key constraints using official
  Chrome extension documentation.
- Map the requested default controls into a feasible browser and Android
  contract.
- Identify exact files for implementation and tests.
- Flag any conflicts with the existing voice-first gesture proposal.

## Do Not Touch

No file edits.


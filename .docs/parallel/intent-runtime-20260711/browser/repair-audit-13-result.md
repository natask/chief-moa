# Browser repair audit 13 result

Status: **PASS for implementation handoff; fresh independent audit required**

## Repairs

- Background sessions now retain the initiating Chrome `documentId`
  (`background.js:2560-2782,4903`). Attach and pagehide cleanup require that
  exact identity (`:3255-3262,4917-4933`). The background-owned
  `tabs.onUpdated(status:"loading")` path disposes all current same-tab voice
  sessions through `closeVoiceSession`/the shared offscreen disposer
  (`:3710-3719,5136-5142`); it never constructs or sends `commit_turn`.
- Content emits an additive one-shot `pagehide` cleanup signal
  (`content.js:4251-4258`). A stale old-document signal is filtered by sender
  document authority and cannot close a replacement session.
- Content normalizes draft context before selecting a parked pointer and sends
  the pointer only for exact `continue` (`content.js:2758-2767,2800-2814`).
  Background independently rejects any resume with `new`, `fork`, or
  `incognito` before session registration/capture/socket creation and checks
  both exact session and branch before WebSocket construction
  (`background.js:2750-2774,2898-2912`).
- Offscreen capture computes the unique set of active/pending/cleaning resource
  generations and enforces a hard 64-owner limit before incrementing generation
  or calling `getUserMedia` (`offscreen.js:12,77-87,341-353`). The status cap is
  therefore a complete enumeration of admitted owners, not a truncation of an
  unbounded acquisition set.

## Production-consumed regression evidence

- `test-voice-session-lifecycle.mjs:172-229` executes the shipped document
  cleanup and navigation listener: before-ready and after-ready old-document
  sessions close, a replacement document and another tab remain untouched,
  and authoritative loading closes the current same-tab session once.
- `test-voice-session-lifecycle.mjs:550-576` executes the shipped setup path for
  `new`, `fork`, and `incognito` with a parked branch-1 pointer and proves zero
  capture allocation, session registration, WebSocket construction, or
  `session_start`.
- `test-offscreen-voice-capture.mjs:291-344` executes the complete shipped
  offscreen runtime: exactly 64 acquisitions are admitted and completely
  reported; limit+1 allocates no media request; reverse settlement leaves one
  owner; exact cleanup permits a fresh capture afterward.
- `verify-extension.mjs:605-627` makes document binding, early cross-branch
  rejection, capacity admission, and executable regressions part of the static
  release gate.

## Verification

```text
cd browser_extension && npm run verify
pass: protocol, gesture, lifecycle, complete offscreen, worker reconciliation,
7 sampler lifecycle tests, static verifier

cd browser_extension && npm run smoke
pass: real unpacked extension in headless Chrome for Testing 143; service worker
loaded; cross-tab revocation and content/background actions exercised; no
window or focus taken

node --check extension/background.js extension/content.js extension/offscreen.js
pass
```

No commit, merge, package, browser reload, preview, or deployment was
performed. A different fresh auditor must reproduce all three findings before
the lane can enter staging.

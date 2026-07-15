# S4 Browser Capture Controls Goal

## Goal

Bring the browser voice-first mark to parity with Android: tap continues, double
tap requests a new root, triple tap opens text, and a confirmed hold resolves
release/send, left/pause, up/park, or down/discard. `pointercancel` must never
send.

## Owned paths

- Browser extension source, focused deterministic gesture test, verify/smoke
  updates, and browser-local documentation only.

## Branch and worktree

- Branch: `agent/browser-draft-controls-20260711`
- Worktree:
  `/Users/natnaelkahssay/projs/chief-moa-worktrees/browser-draft-controls-20260711`

## Acceptance

- Direction/tap resolution is deterministic and independently testable.
- Legacy flag-off behavior is unchanged.
- OS/browser cancellation is discard/no-execute.
- New-root sends `context_action:new`; it does not merely open text.
- Pause and park never commit the turn or generate assistant output.
- The content script keeps local authority and performs no direct gateway,
  provider, or arbitrary execution.

## Verification

`cd browser_extension && npm run verify && npm run smoke`, plus the new focused
gesture-state test.

## Status

- Implemented the flag-gated browser voice-draft control path in extension-owned files only, including deterministic/deferred tap and hold resolution, endpoint-bound capability probing, pre-ID/pre-ready exact PCM ordering, strict canonical authority receipts, and fail-closed resume/SEND behavior.
- Canonical WS protocol is pinned to `voice_draft_ready`, `voice_draft_control`, `voice_draft_control_ack`, and authority-bound draft `commit_turn`; legacy WS control/ACK aliases are not emitted or accepted.
- Focused gesture test passed on 2026-07-11 through `cd browser_extension && npm run verify`: `voice-capture-gesture ok`.
- Verify passed on 2026-07-11: `cd browser_extension && npm run verify` ended with `extension verification passed` and all 7 lifecycle tests green.
- Real headless Chrome smoke passed on 2026-07-11: `cd browser_extension && npm run smoke` ended with `extension smoke passed (REAL extension, headless Chrome for Testing)`.
- No commit, package, browser reload, or deployment was attempted; the main orchestrator requested a green uncommitted handoff for independent audit.

## Do not touch

- Gateway, Android, deployment files, credentials, active browser data, or
  unrelated browser action/tweak behavior.

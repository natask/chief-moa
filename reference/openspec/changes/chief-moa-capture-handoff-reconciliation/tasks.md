# Tasks

## Directed Lane Ownership — 2026-08-03

| Lane | Owner | Claimed paths | State |
| --- | --- | --- | --- |
| Intent/history reconciliation | `/root/owner_chief_moa` | This OpenSpec change only | complete |
| Gateway raw-note deletion | `/root/owner_chief_moa/audio_note_delete` | `gateway/lib/audio-notes.js`, `gateway/lib/media-note-handlers.js`, focused audio/media-note tests and blob smoke | committed as `1856f104`; focused tests and blob smoke green; unpromoted |
| Browser raw-note library | `/root/owner_chief_moa/browser_voice_note_library` | `browser_extension/extension/sidepanel.html`, `sidepanel.js`, bounded audio-note modules, verification/smoke | implemented in this integration unit; list/replay/download/delete plus promotion/retry/handoff are covered by 276 unit tests and the real headless extension smoke; version `0.1.145` is packaged and has a deploy marker, but loaded-browser reload confirmation and installed-loop proof remain unverified |
| Chief-to-Switchboard external contract | coordinator's `/root/switchboard_external_handoff` lane plus `/root/chief_switchboard_handoff` | Switchboard contract outside this repo; bounded Chief gateway client, handler, tests, browser action, and this OpenSpec task | schema-v1 and terminal audio-backed schema-v2 handoff plus explicit browser confirmation implemented in this integration unit; focused coverage and full checks green; no real-Switchboard preview or promotion yet |
| Browser failed-upload persistence | unassigned | future bounded browser outbox module; avoid oversized `background.js` growth | blocked behind a non-overlapping extraction/ownership plan |
| Android and macOS note libraries | unassigned | future Surface-specific clients | blocked on installed source-first proof and dedicated Surface implementation tickets |

Worker-runtime, worktree-registry, and `macos-look-and-ask-intent-capture` were
integrated as separate commits. `CORE_PRODUCT_INTENT.md` accompanies this unit
only to record the clarified portfolio boundary and execution order.

## 1. Recover And Reconcile Intent

- [x] Mine current Codex and Claude Code/Entire history latest-to-oldest.
- [x] Reconcile direct user clarification with current code and OpenSpec.
- [x] Classify implemented, partial, missing, superseded, and blocked claims in
  `intent-ledger-20260803.md` with evidence.

## 2. Recoverable Raw Voice Notes

- [x] Add honest idempotent audio-note deletion across metadata, local spool,
  and configured remote blob storage. Focused store/router tests and fake-GCS
  smoke pass. The unit is committed as `1856f104` and remains unpromoted.
- [ ] Preserve browser raw bytes across upload failure and restart.
- [x] Expose newest-first list, replay/download, failure, and explicit delete in
  the browser full side panel without invoking reasoning or dispatch. Browser
  verify (276 tests), real headless side-panel smoke, and the full browser smoke
  pass. Version `0.1.145` is packaged and has a deploy marker; loaded-browser
  reload confirmation and installed-loop QA remain open.

Acceptance: a stored note survives client restart, replays byte-for-byte, and
an explicit deletion either completes across storage or remains visibly
retryable. Capture/list/replay/delete creates no assistant or agent work.

## 3. Source-First Capture Block

- [x] Create a capture block idempotently from stored audio without STT in the
  upload transaction.
- [x] Add asynchronous transcript failure/retry and immutable-result provenance
  while retaining the source audio. User-authored transcript revision remains a
  separate follow-on contract.
- [x] Show original media, literal transcript, provider/result identity, terminal
  failure, and explicit retry state in the browser side panel.

Acceptance: a forced STT failure leaves the source playable and a later
idempotent retry can complete the transcript.

## 4. Switchboard Handoff

- [x] Ratify a versioned, idempotent Chief-to-Switchboard contract for one
  user-confirmed source revision.
- [x] Store only the external Switchboard identity, request digest, and receipts
  needed for Chief Moa continuity.
- [x] Add one authenticated gateway action for an immutable capture block. It
  requires `confirmed=true` and `authority=execute`, derives a content-bound
  revision and SHA-256 from the exact stored literal transcript, and submits
  `POST /api/v1/external-intents`. A retry returns the locally retained receipt
  and cannot create another admission.
  Verified with focused unit and live-server integration tests, repo-wide
  source-size policy, diff check, strict OpenSpec validation, and the full
  gateway check. The unit remains unpreviewed and unpromoted.
- [x] Extend that action to terminal schema-v2 audio-backed blocks. The revision
  now binds the exact immutable transcript literal, transcript result identity,
  provider evidence, and matching audio-note identity. Unfinished or failed
  transcription states fail before any network call; raw audio remains an
  opaque evidence reference; Chief receipts retain no transcript or media
  details. Focused mismatch, concurrent-idempotency, receipt-minimization, and
  schema-v1 regression coverage pass.
  The enforced focused gate reports 99.49% line, 93.44% branch, and 100%
  function coverage across the handoff service and handler; the full gateway
  check and strict OpenSpec validation pass in the current shared tree.
- [x] Expose explicit browser Hand off only for a terminal immutable transcript,
  retain the stable Switchboard receipt across panel restart, and prove capture
  and transcript preparation make no handoff call or agent run.

Acceptance: retrying the same handoff returns the same Switchboard intent, while
capturing or replaying the source creates no intent or run.

## 5. Installed-Product Proof And Release

- [ ] Verify the complete slice on one installed Surface.
- [x] Create an exact isolated gateway preview artifact and prove inert capture,
  restart recovery, predecessor compatibility, rollback, and drain safety in
  `gateway-preview-evidence-20260803.md`.
- [x] Create the versioned browser extension `0.1.145` package. Its local deploy
  marker does not independently prove a confirmed loaded-browser reload.
- [ ] Promote only after rollback, predecessor compatibility, no interruption,
  state safety, and smoke evidence pass; otherwise record the blocker.

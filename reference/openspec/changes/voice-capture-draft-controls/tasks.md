## 1. Store and protocol

- [x] 1.1 Add revisioned bounded draft persistence, quota, boot recovery, and
  content-free discarded/sent tombstones.
- [x] 1.2 Add draft-mode WebSocket start and pause/resume/park/discard controls.
- [x] 1.3 Route SEND through existing `commit_turn` provider orchestration.
- [x] 1.4 Advertise `voice_drafts_v1` only when the full server path is active.

## 2. Android

- [ ] 2.1 Add pure directional resolver and unit tests.
- [ ] 2.2 Add draft-mode hold, pause, park, resume, send, and discard controls.
- [ ] 2.3 Make `ACTION_CANCEL` discard/no-execute.
- [ ] 2.4 Make explicit new-root failure fail closed.

## 3. Browser

- [ ] 3.1 Add pure directional/tap resolver and deterministic test.
- [ ] 3.2 Add draft-mode mark/background/offscreen controls and local parked ID.
- [ ] 3.3 Make `pointercancel` discard/no-execute.
- [ ] 3.4 Bring voice-first tap/double/triple behavior to the chosen shared map.

## 4. Verification and release

- [x] 4.1 Prove pause/park/resume/discard invoke zero provider/model/tool calls.
- [x] 4.2 Prove park -> restart -> resume -> send preserves audio order.
- [x] 4.3 Run gateway, Android unit/build, and browser verify/smoke gates.
  Evidence: [2026-08-07 cross-surface launch verification](../voice-capture-notebook-ime/cross-surface-dictation-launch-verification-20260807.md).
- [ ] 4.4 Run correctness, privacy, resource, compatibility, and no-gaming
  auditors; repair every BLOCK.
- [ ] 4.5 Create isolated preview/artifacts and apply the active promotion gate.

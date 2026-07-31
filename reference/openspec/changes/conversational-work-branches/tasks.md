## 1. Transcript integrity

- [x] 1.1 Make Android replace gateway transcript snapshots while preserving
  fragment accumulation for the device-local recognizer.
- [x] 1.2 Add a regression test for a long snapshot with an early recognition
  revision.
- [ ] 1.3 Verify the fix with a long physical-phone recording that crosses at
  least one streaming STT rotation.

## 2. Resumable input

- [ ] 2.1 Connect the existing revisioned voice-draft store to the gateway
  session protocol.
- [ ] 2.2 Connect Android and browser pause/resume/park/send/discard controls to
  the advertised capability.
- [ ] 2.3 Prove pause and park create zero provider/model/tool/run activity.

## 3. Conversational coordinator

- [ ] 3.1 Define and persist an idempotent multi-outcome dispatch plan per
  accepted source turn.
- [ ] 3.2 Stream a short foreground response without awaiting admitted runs.
- [ ] 3.3 Create first-class branches/runs for accepted dispatch items and keep
  their status independent from the voice socket.
- [ ] 3.4 Add deterministic tests for partial admission, retries, cancellation,
  and concurrent branch execution.

## 4. Thread recovery

- [ ] 4.1 Add voice-safe list, summarize, select, and disambiguate operations
  over the existing thread store.
- [ ] 4.2 Add Android and browser affordances for returning to a prior thread.
- [ ] 4.3 Prove a reconnect can recover branches and runs without replaying the
  source utterance.

## 5. Verification and release

- [ ] 5.1 Measure transcript, first-token, first-audio, playout, and background
  dispatch timing independently.
- [ ] 5.2 Run gateway, Android, browser, source-size, and strict OpenSpec checks.
- [ ] 5.3 Complete physical-phone pause/resume, long-recording, interruption,
  fan-out, and thread-return QA.
- [ ] 5.4 Create release artifacts and promote only after the active-promotion
  no-interruption, rollback, compatibility, backup/restore, and smoke gate.

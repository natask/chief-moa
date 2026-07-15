# Android draft controls repair audit 2 result

Status: `READY FOR INDEPENDENT RE-AUDIT`

This lane repaired the eight Android blockers from `repair-audit-2.md` without
committing, merging, packaging, installing, or deploying. The implementation
keeps legacy voice selection and the no-provider draft path intact.

## Repair evidence

1. Draft SEND now has one canonical authority envelope.
   `MoaVoiceGatewaySocket.java:270-287` emits exactly `type`,
   `voice_draft_mode`, `voice_draft_id`, `expected_revision`,
   `idempotency_key`, `session_id`, `branch_id`, and `turn_id`. Session and
   branch come from the validated pointer. `MoaGatewayOnboardingTest.java:140-170`
   asserts the exact key set, values, and absence of compatibility aliases.
2. Terminal vocabulary and authority are exact.
   `MoaVoiceDraftSessionState.java:276-303` accepts only `sent|discarded`, exact
   top-level session/branch/turn, matching nested draft/session/branch, and a
   strictly newer integer revision. `MoaStreamingVoiceSessionController.java:1202-1220`
   maps those receipts to `SENT|DISCARDED`; `OverlayService.java:3474-3483`
   clears durable pointers only after an acknowledged terminal result.
3. Persisted and received authority uses the gateway token grammar.
   `MoaVoiceDraftPointer.java:10-32,88-103` requires
   `^[A-Za-z0-9._:-]+$`, a 120-character maximum, and a positive revision;
   values are rejected rather than trimmed. The same constructor validates
   nested network pointers.
4. Protocol regressions are adversarial rather than presence-only.
   `MoaVoiceDraftPointerTest.java:33-54` rejects hostile values in every pointer
   field. `MoaVoiceDraftSessionStateTest.java:173-240` rejects `consumed`,
   missing/mismatched top-level and nested authority, aliases, whitespace,
   controls, path-like tokens, and overlong authority. The valid canonical
   receipts still pass.
5. Control enqueue and ACK admission are one ordered transition.
   `MoaVoiceDraftSessionState.java:163-179` reserves the exact control before
   WebSocket enqueue and permits rollback only for the same action/key.
   `MoaStreamingVoiceSessionController.java:1039-1082` arms the ACK timer before
   enqueue and routes enqueue failure through terminal teardown.
   `MoaVoiceDraftSessionStateTest.java:43-71` delivers the ACK before a
   hypothetical send-return mark and verifies exact rollback behavior.
6. Ready/release has no lost wakeup.
   `MoaVoiceDraftSessionState.java:181-210` atomically records commit demand,
   transport readiness, and the single SEND reservation.
   `MoaStreamingVoiceSessionController.java:1085-1142` flushes buffered PCM,
   marks transport ready, then re-evaluates the current commit state.
   `MoaVoiceDraftSessionStateTest.java:109-122` proves both orderings.
7. Cancellation remains terminal behind an in-flight pause or park.
   `MoaVoiceDraftSessionState.java:129-160,242-274` latches DISCARD, admits the
   first exact ACK, advances authority, then queues DISCARD against that newer
   revision while blocking SEND. `MoaStreamingVoiceSessionController.java:1145-1200`
   keeps the socket alive only for that follow-up. The complete race is covered
   at `MoaVoiceDraftSessionStateTest.java:124-149`.
8. Every draft transport failure has bounded, no-execute teardown.
   `MoaStreamingVoiceSessionController.java:216-313` adopts a warmed mic before
   strict startup validation and suppresses late started callbacks after a
   synchronous socket failure. `:708-740` bounds ready and control ACK waits;
   `:785-835` clears controller state, stops capture/playback, destroys the
   socket, and cancels every timer; `:1345-1369` routes unexpected close/failure
   through that lifecycle. `MoaVoiceDraftFailurePolicy.java:5-49` requires zero
   draft SEND and zero canonical `cancel_turn` for every cause, with coverage in
   `MoaVoiceDraftFailurePolicyTest.java:9-42`. `OverlayService.java:3698-3729`
   destroys the failed controller, preserves only an already validated durable
   pointer, reports a retryable honest state, and does not fall back to a voice
   provider.

## Deterministic verification

- `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --rerun-tasks`
  — `BUILD SUCCESSFUL`; 86 tests, 0 skipped, 0 failures, 0 errors.
- `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
  — `BUILD SUCCESSFUL`.
- `git diff --check -- android_app .docs/parallel/intent-runtime-20260711/android`
  — passed.
- `git diff --no-index --check /dev/null <file>` over every untracked file in
  the slice — passed.

## Residual runtime-only evidence

- This lane does not contain the matching gateway WebSocket integration, so it
  cannot claim gateway QA for ready/control/terminal envelopes or disconnect
  auto-park behavior.
- Real phone QA is still required for warmed-microphone ownership, gesture
  cancellation, Handler/OkHttp callback timing, control timeouts, and normal
  socket close while recording.
- End-to-end preview QA must prove disconnect auto-park, persisted-pointer
  recovery, and a resume revision advancing before capture restarts.
- No preview, rollback, backup/restore, package, install, or active-promotion
  evidence was produced, so deployment remains intentionally blocked.

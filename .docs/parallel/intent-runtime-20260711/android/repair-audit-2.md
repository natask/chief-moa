# Android draft controls repair contract 2

Status: `BLOCK` from the main orchestrator's post-handoff protocol audit.

The Android unit/build gate is green, but the emitted SEND envelope does not
match the frozen cross-surface protocol and the terminal pointer expects a
state the authoritative store does not produce. Do not commit, merge, package,
install, or deploy until these are repaired and independently re-audited.

## Required repairs

1. `MoaVoiceGatewaySocket.buildDraftCommit` must emit the exact draft SEND
   authority: `type:"commit_turn"`,
   `voice_draft_mode:"voice_drafts_v1"`, `voice_draft_id`,
   `expected_revision`, common `idempotency_key`, and exact top-level
   `session_id`, `branch_id`, and `turn_id`. Today it omits mode, session, and
   branch. The builder should derive session/branch from the validated pointer
   or reject a disagreeing explicit value. Add exact positive and forbidden-
   alias assertions.
2. Use one terminal state across store, gateway, Android, browser, and OpenSpec.
   The authoritative draft store's terminal successful state is `sent`;
   Android currently accepts only `consumed|discarded`. Accept `sent` and
   `discarded` only unless the store contract itself is deliberately changed
   everywhere. Validate exact top-level session/branch/turn authority as well as
   the nested pointer and strictly newer revision.
3. `MoaVoiceDraftPointer` is persisted authority and must reject invalid or
   overlong IDs rather than merely trim arbitrary strings. Match the gateway
   authority token grammar and 120-character bound for draft/session/branch
   identifiers. Add persisted and network-receipt regressions for whitespace,
   control characters, path-like input, and overlong values.
4. Extend deterministic protocol tests so a green gate proves every required
   SEND field, the exact terminal-state vocabulary, top-level/nested authority,
   and rejection of extra compatibility aliases.

## Verification

- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --rerun-tasks`
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
- `git diff --check -- android_app .docs/parallel/intent-runtime-20260711/android`

Report exact file:line evidence and residual runtime-only risks. Do not claim
phone/gateway QA until the matching gateway implementation exists.

## Independent audit 2026-07-11: `BLOCK` confirmed and expanded

The required Gradle gate remains green, but the green tests encode the wrong
terminal vocabulary and do not exercise several controller races. The original
three protocol blockers remain:

1. `MoaVoiceGatewaySocket.java:270-284` builds draft SEND with only
   type/turn/draft/revision/idempotency. It still omits
   `voice_draft_mode`, `session_id`, and `branch_id`. The positive test at
   `MoaGatewayOnboardingTest.java:111-144` asserts only the incomplete fields
   and never asserts the exact key set or forbidden aliases.
2. `MoaVoiceDraftSessionState.java:181-200` accepts
   `consumed|discarded`, while the authoritative store and frozen contract use
   `sent|discarded`. It validates top-level turn only, not top-level session and
   branch. `MoaVoiceDraftSessionStateTest.java:62-72` explicitly makes
   `consumed` pass, so the unit gate is self-consistent with the wrong protocol.
   `MoaStreamingVoiceSessionController.java:954-969` then maps every accepted
   non-discard terminal receipt to `CONSUMED`, and the overlay only clears that
   mismatched state.
3. `MoaVoiceDraftPointer.java:14-25,101-103` trims arbitrary values and checks
   only non-empty strings. It therefore accepts whitespace-normalized,
   control-character, path-like, and over-120-character draft/session/branch
   authority instead of the gateway grammar `^[A-Za-z0-9._:-]+$` with a
   120-character maximum. `MoaVoiceDraftPointerTest.java:18-30` covers only a
   string revision and an extra content field, not hostile authority tokens.

The independent controller audit found these additional blockers:

4. Control delivery is not atomic with ACK admission.
   `MoaStreamingVoiceSessionController.java:842-855` enqueues the WebSocket
   control before marking it sent; a fast ACK can reach
   `MoaVoiceDraftSessionState.java:152-158` while `sent` is still false and be
   irreversibly rejected. Introduce an atomic in-flight/reservation transition
   before enqueue with a safe rollback/retry contract, or an equivalent design
   that cannot lose the exact ACK.
5. Readiness and SEND have a lost-wakeup race.
   `MoaStreamingVoiceSessionController.java:860-908` snapshots
   `shouldFinishCommit`, then removes the pending-commit timeout and marks the
   session ready outside that state transition. A concurrent release after the
   snapshot can set `pendingCommitAfterSessionReady`, after which readiness
   removes its timeout but never sends the commit. Re-evaluate and consume the
   pending SEND atomically after readiness/audio flush, and add both race
   orderings to a deterministic test seam.
6. `ACTION_CANCEL` is not terminal when another control is already in flight.
   `MoaVoiceDraftSessionState.java:90-107` lets DISCARD replace only an unsent
   pause/park. If cancellation arrives after a non-discard control was sent but
   before its ACK, discard is rejected and user content remains paused/parked.
   Latch terminal cancellation, accept the first exact ACK, then send discard
   against the newer authority; never allow SEND while that latch exists.
7. Setup/control failure and socket teardown can strand capture or authority.
   A failed `session_start` only reports an error
   (`MoaStreamingVoiceSessionController.java:424-465`), a failed control send
   only reports an error and leaves the controller active/pending
   (`:823-857`), and a gateway error only reports (`:1260-1262`). The overlay's
   draft error branch surfaces text but intentionally does not tear down
   (`OverlayService.java:3698-3719`). An unexpected normal socket close clears
   flags but never stops `captureController` (`MoaStreamingVoiceSessionController.java:1095-1113`),
   so a pre-ready microphone can remain live. Every terminal transport failure
   must stop capture, close/destroy the socket, preserve only validated parked
   authority, and reach a retryable honest UI state without provider fallback.
8. Readiness and control acknowledgements have no bounded timeout unless SEND
   has already been requested. A new draft can capture indefinitely while a
   socket stays open without `voice_draft_ready`; a pre-ready pause/park/discard
   can remain pending indefinitely; and a sent control can wait forever for an
   ACK. Add bounded, cancelable ready/control timers and test that expiry stops
   the microphone, sends no canonical `cancel_turn` or SEND, and preserves or
   auto-parks authority explicitly.

The resolver and capability/admission seams pass source review: dominant-axis
thresholding and `ACTION_CANCEL` resolve correctly; capability is URL-bound,
strict-boolean, 30-second fresh, and latched at pointer-down; explicit
new/incognito admission resolves before socket open and fails closed; persisted
JSON contains only ID/revision/session/branch; legacy voice remains selected
when capability is absent/stale; and buffered pre-ready PCM is byte-bounded.
Those positives do not override the authority, concurrency, teardown, and
resource blockers above.

Required deterministic regressions now include exact SEND key-set/alias
rejection, `sent|discarded` terminal vocabulary with exact top-level and nested
authority, hostile pointer tokens, ACK-before-send-return, release-vs-ready in
both orders, cancellation during an in-flight pause/park, ready/control timeout,
normal socket close while capturing, and setup/control enqueue failure. Tests
must assert zero SEND, zero `cancel_turn`, and stopped capture on every pre-SEND
failure/cancellation path.

Fresh verification from the isolated Android worktree:

- `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --rerun-tasks`
  — `BUILD SUCCESSFUL` (21 tasks executed).
- `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug` —
  `BUILD SUCCESSFUL`.
- `git diff --check -- android_app .docs/parallel/intent-runtime-20260711/android`
  — PASS before this audit-note append; rerun required after the append.

No commit, merge, package, install, deployment, phone QA, or gateway QA was
performed.

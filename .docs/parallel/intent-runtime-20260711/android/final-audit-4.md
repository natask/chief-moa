# Android draft controls final audit 4

Status: **BLOCK**

The candidate passes its committed JVM/build checks and several protocol
invariants are now strong, but independent adversarial execution found four
controller failures and two Overlay callback-lifecycle failures. The lane is
not safe to commit, merge, package, install, preview, or deploy yet.

## What passed

- The injectable `Scheduler`, `CapturePort`, and `SocketPort` are genuine
  production-consumed seams, not policy-only test doubles. The production
  controller declares them at
  `MoaStreamingVoiceSessionController.java:78-158`, installs Handler,
  `MoaAudioCaptureController`, and `MoaVoiceGatewaySocket` adapters at
  `:160-347`, and consumes the injected factories in the same constructor and
  effect sites at `:429-450`, `:552-574`, `:881-923`, `:1589-1644`, and
  `:2019-2393`.
- The exact alias-free draft start and exact eight-key SEND are asserted by
  production builders and key-set tests at
  `MoaVoiceGatewaySocket.java:202-241,273-290` and
  `MoaGatewayOnboardingTest.java:87-142,165-222`.
- Raw branch authority rejects numeric, padded, aliased, path-like, and
  malformed values at `MoaGatewayClient.java:118-139,701-707`, with tests at
  `MoaGatewayOnboardingTest.java:145-163`.
- The byte and elapsed-time health bounds are production paths at
  `MoaGatewayClient.java:25-35,40-54,376-441,658-700`; oversize and drip-feed
  tests pass at `MoaGatewayClientTest.java:75-105`.
- The existing controller suite passes its deterministic pre-SEND event gate,
  parked restart/resume/zero-PCM SEND, timeout-wins, ACK-wins, synchronous ACK,
  synchronous capture-error, exact terminal, and already-queued-callback cases
  at `MoaStreamingVoiceSessionControllerTest.java:19-340`.
- Adjacent lifecycle increment across `Long.MAX_VALUE` wraps to a different
  epoch; equality does not immediately reuse the retired epoch. Actual reuse
  would require a full 64-bit cycle. The smaller Overlay generation and switch
  tokens remain `int`, but their practical wrap horizon is not the present
  blocker; the ordinary callback identity failures below happen without any
  overflow.

## Blocking findings

### 1. A canonically sent draft cannot play gateway audio

`MoaStreamingVoiceSessionController.java:564-566` deliberately sets
`playbackController` to `null` for every local draft. After SEND, the normal
assistant-audio handlers only start or write when that object is non-null
(`:2257-2273`, `:2277-2299`). The Overlay nevertheless marks audio as received,
so the local fallback can also be suppressed while no PCM was played.

An audit-only production-controller probe enabled playback, completed an
authoritative resume, emitted canonical SEND, and inspected the production
field. The desired regression `committedDraftRetainsAPlaybackSinkForAssistantAudio`
failed because the sink was null.

Required repair: retain/create a playback controller for the post-SEND phase
while continuing to gate every pre-SEND audio event. Add a production-effect
regression proving start, PCM write, drain, and terminal stop after SEND, plus
zero playback before SEND.

### 2. Lifecycle retirement can lose a race inside capture start and leave the microphone live

`startCaptureIfNeeded` validates the epoch, releases the lock, then calls
`capture.start` (`MoaStreamingVoiceSessionController.java:881-910`). If
destroy/timeout/cancel wins after the snapshot but before the capture becomes
live, teardown calls `stop` too early. The outer method only returns false on
its post-start epoch check (`:921-923`); it never compensates by stopping the
capture that became live after retirement.

An audit-only `CapturePort` invoked `destroy()` inside `start()` immediately
before becoming live, the deterministic equivalent of that interleaving. The
desired regression `teardownWinningInsideCaptureStartCannotLeaveTheMicLive`
failed with `capture.live == true` after controller destruction.

Required repair: reserve capture start against the exact lifecycle and, if the
post-call epoch/port identity check fails, synchronously stop that exact port.
Add equivalent reentrant/parallel tests for cold start and authoritative resume.

### 3. A fast response to canonical SEND is misclassified as a pre-SEND violation

The controller reserves commit authority, calls `sendDraftCommit`, and only
after that call returns sets `draftExecutionEventsAllowed=true`
(`MoaStreamingVoiceSessionController.java:1002-1047`). Once the socket has
enqueued SEND, its callback thread may deliver a response before the caller has
returned. `maybeHandleDraftGatewayEvent`/`admitExecutionCallback` then retire the
turn as if SEND never happened (`:1822-1889`).

An audit-only `SocketPort` delivered `transcript_final` while a successful
`sendDraftCommit` was returning. The desired regression
`canonicalSendAllowsAConcurrentFastServerEvent` failed: expected one post-SEND
transcript callback, observed zero and terminal failure.

Required repair: model SEND reservation/in-flight/success explicitly. Buffer
or otherwise hold execution callbacks that race the transport return, publish
them only after a successful enqueue, and retire/drop them on false/throw.
Tests must cover callback-before-return for success, false, and exception.

### 4. Post-SEND text/progress callbacks do not require exact turn authority

`admitExecutionCallback` rejects a mismatch only when `safe(eventTurnId)` is
non-empty (`MoaStreamingVoiceSessionController.java:1869-1881`). Therefore an
empty, missing, or whitespace-only `turn_id` is admitted after SEND. Transcript,
assistant-text, and progress handlers can then mutate history or launch routing
against the current turn (`:2230-2253`, `:2331-2337`; Overlay effects begin at
`OverlayService.java:3492-3543`). Binary PCM legitimately has no JSON turn id,
but that is a distinct callback and cannot justify weakening text authority.

An audit-only post-SEND `assistant_text` event with no turn authority reached
the application callback. The desired regression
`postSendTextStillRequiresExactTurnAuthority` failed with assistant-text count
one instead of zero.

Required repair: require exact current `turn_id` for every JSON execution
callback. Keep binary-frame admission as a separate socket/epoch-bound path.
Test missing, empty, padded, malformed, and cross-turn IDs for partial/final
transcript, assistant text/start/done, progress, and terminal events.

### 5. An in-flight draft branch resolver can reopen a socket and microphone after service destruction

Draft new/incognito admission starts a background switch and accepts its posted
result using only `streamingSwitchToken`
(`OverlayService.java:3121-3159`). `onDestroy` does not invalidate that token,
advance `streamingVoiceGeneration`, or remove the posted resolver
(`OverlayService.java:343-367`). A result already in flight can therefore pass
the token check after service destruction and call
`openStreamingVoiceDraftSession`, which constructs and starts a new controller,
socket, and cold capture (`:3181-3218`). The `running=false` field is not checked.

Required repair: retire both switch and streaming identities before any destroy
effects, and make every resolver/posted open check service liveness plus its
exact request identity. Add an Overlay-level deterministic seam/test for
destroy-before-response and destroy-after-post-before-run.

### 6. Commit-on-open is queued without controller or generation authority

When release happens during branch resolution, draft admission posts
`this::commitStreamingVoiceTurnNow` (`OverlayService.java:3181-3220`); the
legacy branch path has the same issue at `:3370-3377`. At execution time that
method reads whichever controller is currently stored
(`OverlayService.java:2634-2639`). A cancel/new-start event already ahead of the
posted commit can replace controller A with controller B, after which A's stale
release commits B.

Required repair: capture the admitted controller and generation in the queued
callback, require both identities and the original pending-release token at
execution, and call `commitStreamingVoiceTurnResolved` only on that exact
controller. Add queue-order regressions for cancel, discard, destroy, and
replacement-start between open and queued commit.

## Executable evidence

Baseline candidate, before the audit probe:

- `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --rerun-tasks`
  — PASS, 104 tests, 0 failures/errors/skips across 15 suites.
- `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
  — PASS.

Independent audit-only probe:

- `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --tests ai.moa.assistant.MoaStreamingVoiceSessionControllerAuditProbeTest --rerun-tasks`
  — expected-regression run: 4 tests executed, all 4 exposed the candidate and
  failed with the exact results described in blockers 1-4.
- The ephemeral probe source was then removed. It was never committed and made
  no production change.

After probe removal, a clean combined rerun
(`./gradlew clean testDebugUnitTest --rerun-tasks assembleDebug`) passed all 39
tasks and rebuilt the same 104-test/15-suite zero-failure result. Tracked
`git diff --check` and per-untracked-file `git diff --no-index --check` also
passed. Those green baseline checks do not override the four independently
reproduced missing invariants or the two source-proven Overlay lifecycle
blockers.

## Re-audit contract

A repair is not green until a fresh auditor can run the full 104-test baseline
plus durable regressions for all six findings, with no implementation-only
assertions. The regressions must drive the production controller/Overlay effect
seams and prove actual playback, stopped capture, buffered fast SEND response,
strict event authority, destroyed resolver inertness, and exact queued-commit
identity. Real-phone and matching-gateway preview QA remain required after that
code gate; they are not substitutes for these deterministic failures.

No implementation, commit, package, install, preview, merge, or deployment was
performed by this audit.

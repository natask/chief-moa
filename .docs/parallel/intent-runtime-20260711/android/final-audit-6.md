# Android draft controls final audit 6

Status: **BLOCK**

The six `final-audit-4` repair classes now hold against the production-consumed
controller and Overlay seams, but the candidate is not release-safe. Fresh
adversarial execution reproduced two data/resource failures, and source tracing
found a separate explicit-root capture-loss path. Do not commit, merge, package,
install, preview, or deploy this lane yet.

## Reproduction of the six repaired blockers

1. **Playback exists only after SEND:** PASS. The focused production-controller
   regression proved zero pre-SEND sink effects and one post-SEND start, write,
   drain, and stop (`MoaStreamingVoiceSessionControllerTest.java:345-380`). The
   real adapter is installed at
   `MoaStreamingVoiceSessionController.java:221-249,645-649`.
2. **Capture-start teardown race:** PASS. Reentrant cold and resumed starts and
   parallel resumed teardown pass at
   `MoaStreamingVoiceSessionControllerTest.java:397-443`. A fresh audit-only
   parallel cold-start barrier also passed: destroy won while `start()` was
   outside the lock, the exact port was stopped once, and no capture remained
   live. The production compensation is at
   `MoaStreamingVoiceSessionController.java:966-1032`.
3. **Callback before SEND return:** PASS. Success publishes the held callback
   once; false and throw publish none and terminate. The focused regression at
   `MoaStreamingVoiceSessionControllerTest.java:446-489` passed against
   `sendDraftCommit`, and the bounded in-flight state is implemented at
   `MoaStreamingVoiceSessionController.java:1111-1187,2048-2102`.
4. **Exact turn authority:** PASS. All JSON-derived partial/final transcript,
   assistant text/audio boundaries, progress, and terminal callbacks require the
   exact untrimmed turn ID at
   `MoaStreamingVoiceSessionController.java:2464-2673`; missing, empty, padded,
   malformed, and cross-turn values fail closed in the regression at
   `MoaStreamingVoiceSessionControllerTest.java:492-527`. Binary PCM remains a
   distinct socket/epoch path at `MoaVoiceGatewaySocket.java:477-488` and
   `MoaStreamingVoiceSessionController.java:2538-2569`.
5. **Destroy before branch resolver/post:** PASS. `onDestroy` retires switch,
   generation, and release identities before effects and removes existing posts
   (`OverlayService.java:347-370`). Both resolver continuations invoke the exact
   service/token gate at `OverlayService.java:3190-3209,3353-3379`, and the
   focused gate regressions pass.
6. **Queued commit identity:** PASS. The posted effect captures the exact
   controller, generation, and release token
   (`OverlayService.java:2687-2707,3273-3279,3439-3448`). Cancel/replacement
   invalidates through `invalidatePendingBranchSwitch`; pause, park, discard,
   and destroy advance the release identity at
   `OverlayService.java:348-355,2469-2541,3090-3106,3382-3387`. Wrong service,
   generation, controller, and token all produced zero commit effects in
   `MoaStreamingVoiceContinuationGateTest`.

## Blocking findings

### 1. A valid completed terminal can strand the owned playback sink

`handleTurnDone` retires the lifecycle, but deliberately skips `playback.stop()`
when assistant audio started and status is `completed`
(`MoaStreamingVoiceSessionController.java:1295-1333`). The only remaining stop
is scheduled by an earlier `assistant_audio_done`
(`MoaStreamingVoiceSessionController.java:2573-2605`). If the gateway sends
`assistant_audio_start`, PCM, and an authoritative completed `turn_done` without
that boundary, the sink remains started forever; a later audio-done callback is
inert because terminal retirement already advanced the epoch.

An audit-only production-controller probe reproduced this exact sequence. It
observed one playback start, one write, an inactive terminal controller, and
zero stops; the desired assertion failed `expected:<1> but was:<0>`. The probe
was removed after execution.

Required repair: terminal cleanup must always own a bounded, idempotent drain
and stop of the exact sink, including missing, late, duplicate, or reordered
audio-done. Add the malformed-sequence regression to the durable suite.

### 2. Pre-authority draft capture silently deletes the beginning of speech

New default-branch drafts start local capture before `voice_draft_ready` and
buffer PCM (`MoaStreamingVoiceSessionController.java:683-717,2253-2281`). The
buffer is five seconds, but overflow removes oldest chunks without an error or
terminal state (`:33,1621-1631`). Readiness may legitimately wait ten seconds
(`:30,691-696`), so the supported timing window is larger than the retention
window. `capturedAudioBytes` still counts discarded bytes, and SEND proceeds as
if the utterance were intact.

An audit-only production-controller probe emitted 41 ordered 4,000-byte chunks
(164,000 bytes) before an otherwise valid ready receipt. The controller reported
zero errors but sent only 40 chunks; the exact-order assertion failed
`expected:<41> but was:<40>`. The probe was removed after execution.

Required repair: never silently truncate a confirmed draft. Preserve ordered
PCM within an explicit bound, or stop/fail visibly and prohibit SEND when that
bound is reached. Add exact first/last-byte and overflow regressions.

### 3. New/incognito branch resolution can overwrite the whole utterance before the draft opens

Explicit-root admission waits for `/v1/threads/switch` before constructing the
controller (`OverlayService.java:3128-3210`). During that wait, the confirmed
hold still owns only `warmMic`; its pre-roll retains just 500 ms and continuously
drops the oldest frames (`MoaAudioCaptureController.java:29-32,229-235`). A
release merely records `streamingCommitPendingOpen` and leaves that rolling mic
unchanged (`OverlayService.java:2460-2474`). The mic is adopted only after the
branch response (`:3231-3279`).

The switch request allows a 3.5-second connect and 15-second read
(`MoaGatewayClient.java:77-79,286-290`). Therefore ordinary delay after release
can replace every spoken frame with later silence before adoption, after which
the queued exact commit sends a near-empty draft. Identity safety does not
preserve content.

Required repair: at confirmed hold, transfer the mic into a bounded full-draft
collector associated with the exact resolver token, or freeze the exact ordered
capture on release. Branch success may then hand those bytes to the admitted
controller; failure/cancel must destroy them without SEND.

## Bounds, compatibility, and audit-quality notes

- Fast-SEND callbacks are bounded to 64 callbacks and 2 MiB and overflow fails
  closed (`MoaStreamingVoiceSessionController.java:33-35,2077-2099`). Ready,
  control-ACK, and commit waits are bounded. Exact authority and terminal
  single-use admission remain intact.
- Flag-off/stale-capability behavior still selects the legacy gesture path, and
  the complete legacy/draft JVM suite remains green. Real phone and matching
  gateway preview QA are still required; this audit performed neither.
- `repair-audit-5-result.md` claims durable parallel coverage for both cold and
  resumed capture start. The durable suite contains parallel resume only; the
  fresh cold case passed only as an audit probe and was removed. This is an
  overstated test claim and leaves a required regression absent even though the
  current implementation passed the missing interleaving.

## Executable evidence

- Full post-probe-removal gate:
  `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew clean testDebugUnitTest --rerun-tasks assembleDebug`
  — PASS, 39 tasks executed; 112 tests, 0 failures/errors/skips across 16 suites.
- Focused six-blocker rerun — PASS, 7 tests: five production-controller tests
  plus both production-consumed continuation-gate tests.
- Audit-only parallel cold-start probe — PASS, 1 test.
- Audit-only missing-audio-done probe — expected-regression FAIL, 1 test,
  playback stops `expected:<1> but was:<0>`.
- Audit-only pre-ready PCM integrity probe — expected-regression FAIL, 1 test,
  ordered frames `expected:<41> but was:<40>` with zero reported errors.
- All ephemeral probe methods were removed. No production source was edited by
  this audit.

No commit, merge, APK packaging/publication, install, preview, or deployment was
performed.

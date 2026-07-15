# Android repair audit 5 result

Status: **PASS for implementation handoff; fresh independent audit required**

## Production repairs

- `MoaStreamingVoiceSessionController.java:116-253,418,649` now owns an
  injectable production playback port backed by the real
  `MoaAudioPlaybackController`. Draft sessions retain that sink, while exact
  post-SEND admission remains the only path that may start/write/stop it.
- `MoaStreamingVoiceSessionController.java:988-1035` reserves the exact capture
  port across `start()`. A lifecycle/control/identity loss after the call
  synchronously stops that same port; a throwing start also receives a
  compensating stop.
- `MoaStreamingVoiceSessionController.java:1110-1187,1964-2099` reserves an
  explicit SEND-in-flight boundary. Bounded callbacks that race
  `sendDraftCommit()` are held with no application effect, replayed in raw then
  typed order only after a true return, and cleared on false, throw, or any
  lifecycle retirement.
- `MoaStreamingVoiceSessionController.java:2048-2099,2464-2657` requires the
  exact untrimmed current `turn_id` for every JSON-derived transcript,
  assistant-text/audio-boundary, progress, and terminal callback. Binary PCM
  has a distinct epoch/socket admission. The separately authorized pre-SEND
  discard terminal remains valid and single-use.
- `MoaStreamingVoiceSessionController.java:2584-2607` stops the exact playback
  sink after its drain window even when `turn_done` retires the lifecycle in
  that window.
- `OverlayService.java:344-368` retires switch, streaming-generation, and
  pending-release identities and removes service-owned posts before destroy
  effects. Resolver continuations run through the production-consumed gate at
  `OverlayService.java:3190-3209,3353-3380`.
- `OverlayService.java:188,2460-2541,2631,2686-2707,3233-3280,3391-3449`
  binds queued commit-on-open to the exact controller, generation, and release
  token. Cancel, pause, park, discard, destroy, replacement, and duplicate
  execution retire that token. The pure effect gate is implemented at
  `MoaStreamingVoiceContinuationGate.java:14-50` and directly wraps the
  production open/commit continuations.

## Regression evidence

- `MoaStreamingVoiceSessionControllerTest.java:343-510` drives the production
  controller seams and proves zero pre-SEND playback, real post-SEND
  start/write/drain/stop, authoritative discard without SEND, cold and resumed
  reentrant and parallel teardown-inside-start cleanup,
  callback-before-return success/false/throw,
  and strict authority for every JSON execution callback.
- `MoaStreamingVoiceContinuationGateTest.java:13-73` drives the same gate used
  by Overlay and proves destroyed/superseded branch results have zero open
  effects and wrong service/generation/controller/release identities have zero
  commit effects.
- The existing timeout, ACK race, synchronous capture/control callback,
  terminal, cancellation, restart, gesture, protocol, and onboarding tests
  remain green.

## Verification

```text
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew clean testDebugUnitTest --rerun-tasks assembleDebug
BUILD SUCCESSFUL; 39 tasks executed
112 tests, 0 failures, 0 errors, 0 skipped

git diff --check
pass

per-untracked-file git diff --no-index --check
pass
```

No commit, merge, APK publication, installation, preview, or deployment was
performed. A fresh auditor must reproduce the six original blocker classes;
real-phone and isolated matching-gateway preview QA still gate release.

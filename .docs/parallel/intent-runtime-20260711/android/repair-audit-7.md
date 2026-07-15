# Android repair audit 7 contract

Status: **implementation in progress; lane remains blocked**

## Goal

Repair the three release blockers from `final-audit-6.md` without weakening the
previously-audited SEND authority, exact-turn identity, lifecycle compensation,
or branch-continuation gates.

## Owned files

- `android_app/app/src/main/java/ai/moa/assistant/MoaAudioCaptureController.java`
- `android_app/app/src/main/java/ai/moa/assistant/MoaStreamingVoiceSessionController.java`
- `android_app/app/src/main/java/ai/moa/assistant/OverlayService.java`
- narrowly-scoped production-consumed helper classes under the same package
- corresponding JVM tests under `android_app/app/src/test/java/ai/moa/assistant/`
- this lane's audit result documents

## Implementation contract

1. A completed terminal owns an idempotent, bounded drain-and-stop of the exact
   playback sink even when `assistant_audio_done` is missing, late, duplicated,
   or reordered. No playback effect may occur before authoritative SEND.
2. Pre-ready PCM is retained in exact order within an explicit 60-second PCM16
   mono bound. Capacity exhaustion is a visible terminal failure that clears
   buffered bytes and prohibits SEND; no oldest-frame eviction is permitted.
3. A confirmed explicit-root hold promotes the warm microphone to a bounded
   full-draft collector. Release before branch resolution freezes the exact
   ordered bytes and stops hardware. Exact resolver success may transfer those
   bytes once; cancellation, failure, replacement, or destruction clears them
   with zero SEND.
4. Add durable regressions for missing audio-done, 41 ordered pre-ready frames,
   exact capacity plus one, deferred capture freeze/drain/cancel/overflow, and
   parallel cold capture-start teardown. Tests must exercise production-used
   seams, not duplicate policy in fixtures.

## Do not touch

- gateway, browser-extension, or active deployment trees
- provider credentials, live data, phone installation, or the live gateway
- existing authority semantics for canonical SEND, pause, park, discard, or
  exact untrimmed turn IDs

## Acceptance and verification

- `final-audit-6` probes become durable and pass.
- Existing Android draft/legacy behavior remains green.
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew clean testDebugUnitTest --rerun-tasks assembleDebug`
- tracked and per-untracked-file whitespace checks pass.
- A different independent auditor returns PASS before commit, merge, artifact,
  preview, or deployment.

## Live-app constraints

This worktree is isolated. Do not install an APK, restart an active process,
package/publish an artifact, call live mutation routes, or promote anything.


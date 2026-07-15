# Repair contract: Android final-audit-4 blockers

## Required fixes

1. Retain or create the real playback sink for a draft's post-SEND phase while
   keeping every pre-SEND audio callback inert. Prove actual sink start, PCM
   write, drain, and terminal stop after SEND and zero playback before SEND.
2. Reserve capture start against an exact lifecycle/port identity. If teardown
   wins reentrantly or concurrently before `CapturePort.start()` returns,
   synchronously stop that exact newly-live port before returning. Cover cold
   start and authoritative resume.
3. Model SEND as reserved/in-flight/succeeded/failed. Execution callbacks that
   arrive before `sendDraftCommit()` returns must be held without application
   effects, published only after successful enqueue, and retired on false or
   throw. No callback may observe an ambiguous pre/post-SEND boundary.
4. Require exact current `turn_id` on every JSON execution callback after SEND:
   all transcript variants, assistant text/start/done, progress, and terminal
   events. Missing, empty, padded, malformed, or cross-turn authority fails
   closed. Binary PCM remains a separate socket+epoch-bound path.
5. Invalidate branch-switch token, streaming generation, and posted-open
   identity before Overlay destruction effects. Every switch response and
   posted resolver must check service liveness plus exact request identity so it
   cannot reopen a socket/mic after `onDestroy`.
6. Bind commit-on-open callbacks to the exact admitted controller, generation,
   and pending-release token. Never read and commit whichever controller is
   current when the callback later runs.

## Required production-effect regressions

- post-SEND assistant PCM starts/writes/drains/stops the real injected playback
  port; pre-SEND PCM does none of them;
- destroy/timeout/cancel inside capture start and parallel teardown leave the
  exact port stopped for cold start and resume;
- callback-before-SEND-return for success, false, and exception produces,
  respectively, one ordered effect or zero effects plus terminal failure;
- every JSON execution type rejects missing/empty/padded/malformed/wrong turn;
- destroy-before-switch-response and destroy-after-post-before-run create no
  controller/socket/capture;
- cancel/discard/destroy/replacement between open and queued commit cannot
  commit a replacement controller.

Tests must drive production-consumed controller and Overlay seams. Do not use a
policy object as proof.

## Ownership and constraints

Own only `android_app/**` and this Android lane's durable notes. Do not touch
gateway/browser/active tree. Do not commit, install, package, merge, or deploy.

## Verification

```sh
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew clean testDebugUnitTest --rerun-tasks assembleDebug
git diff --check
```

Write `repair-audit-5-result.md` with exact file:line/effect evidence. Root will
assign a fresh auditor and later require real-phone + isolated gateway preview.

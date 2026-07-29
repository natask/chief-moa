# Android Feedback Software Factory V0

## Why

Chief Moa can store exact-release feedback and can run repository workers, but
there is no owned lifecycle between those systems. Routine Android QA also
depends on an attached personal phone even when the behavior is testable in an
emulator. This leaves explicit implementation intent without one accountable
owner and leaves candidate evidence disconnected from the APK that was tested.

## First milestone

Close one Android-only loop:

```text
exact installed-candidate feedback
  -> explicit Create fix authorization
  -> one durable modification intent, task, run, and owner
  -> isolated worktree based on recorded origin/master
  -> continuity-signed candidate APK
  -> deterministic Mac emulator QA and exact-artifact evidence
  -> revocable preview candidate visible in Android
```

This milestone does not promote stable. Personal-phone feedback is the later
acceptance lane, not the routine pre-release QA gate.

## Boundaries

- Feedback, screenshots, video, transcripts, and model output are evidence.
  They cannot authorize implementation or deployment.
- Only the explicit `Create fix` action creates implementation authority.
- Every implementation-authorized request has exactly one current owner or an
  explicit terminal/blocked state; it cannot remain silently unowned.
- Workers start from the recorded current `origin/master`, never from the
  installed candidate's feature branch or an arbitrary dirty checkout.
- The VPS may coordinate runners but is not assumed to run Android Emulator.
- No app or device credential can sign, publish, promote, or administer a
  release.

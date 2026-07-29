# Tasks

## 0. Contract

- [x] 0.1 Select Android-only, feedback-owned candidate delivery as V0.
- [x] 0.2 Select Mac emulator as routine QA, Firebase virtual Pixel as the
      independent candidate gate, and physical Pixel QA for release candidates.
- [x] 0.3 Keep stable promotion and personal-phone QA outside the routine gate.

## 1. Gateway ownership coordinator

- [x] 1.1 Validate exact release-bound feedback and explicit current
      `implementation_authorized` Create-fix input.
- [x] 1.2 Idempotently create one request, canonical intent, task, queued run,
      and owner lease; reject conflicting retries and ownerless queued states.
- [x] 1.3 Pin `origin/master` and its resolved commit in the work request and
      expose a joined status projection with explicit blockers.

Acceptance: one request retry returns the same full identity set; a feedback-only
submission starts nothing; every nonterminal authorized request is owned or
visibly reclaimable/blocked.

## 2. Emulator QA and evidence

- [x] 2.1 Add a hermetic AVD wrapper and UI Automator runtime scenario for
      partial, final, expanded, History, and Copy behavior.
- [x] 2.2 Add debug-only deterministic state injection and collect JUnit,
      interaction trace, screenshots, UI XML, logcat, and screenrecord video.
- [x] 2.3 Add an exact-artifact evidence manifest/verifier and an isolated CI
      entrypoint suitable for Mac and Firebase runners.

Acceptance: one command either produces verified `emulator_smoked` evidence
bound to the exact APK/test APK and scenario, or reports a precise dependency or
scenario blocker without requiring a personal phone.

## 3. Android request surface and video foundation

- [x] 3.1 Add explicit Create-fix authorization from exact-running-release
      feedback and display the returned request/intent/run owner identities.
- [x] 3.2 Add a durable status view for queued, owned, running, QA, candidate,
      blocked, failed, completed, and reclaimable states.
- [x] 3.3 Add explicit video-note capture state, typed artifact descriptors,
      cancellation, bounds, and exact feedback binding without claiming upload.

Acceptance: ordinary feedback remains inert; Create fix is a distinct explicit
action; video state is truthful and remains evidence-only.

## 4. Candidate bridge and independent verification

- [ ] 4.1 Admit a revocable Android preview candidate only after exact APK and
      matching emulator evidence are present; keep assignment/install/smoke
      separate.
- [x] 4.2 Run gateway, release-control, Android unit/build, emulator evidence
      verification, and adversarial idempotency/authority tests.
- [x] 4.3 Commit each coherent unit. Build a preview artifact when the checks
      pass, but do not promote stable.

Implementation note (2026-07-28): candidate admission and its exact-binding
tests exist, but production remains fail-closed with
`authoritative_candidate_evidence_unavailable` until a runner/storage adapter
can retrieve the retained manifest and APK bytes and prove durable preview
publication. Caller assertions cannot satisfy 4.1. The current master-integrated
Mac run produced verified `emulator_smoked` evidence; no preview was published
and stable was not changed.

Acceptance: Android can inspect the exact candidate produced for its request;
the release plane refuses mismatched evidence; no stable channel changes.

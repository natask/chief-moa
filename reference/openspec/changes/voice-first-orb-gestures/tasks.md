## 1. Canonical Browser Gesture Contract

- [x] 1.1 Make single click toggle current-thread capture and commit once.
- [x] 1.2 Make double-click start fresh-thread capture and allow either a later
      single or double click to stop and commit once.
- [x] 1.3 Keep triple-click for chat, hold-release for push-to-talk, and drag for
      movement without cancelling unrelated provider work.
- [x] 1.4 Remove the browser gesture flag, checkbox, stored preference, legacy
      fallback, and review-draft side controls without adding another setting.

## 2. Permission Recovery Interaction

- [x] 2.1 Load the offscreen receiver as a module, add a bounded readiness
      handshake/retry, and distinguish runtime startup from permission denial.
- [x] 2.2 Keep capture failures visible in the active surface and remove the
      unconditional Options redirect.
- [x] 2.3 Add an explicit `Take me to microphone setup` action and focus Options
      on guided steps and the user-operated Grant microphone control.

## 3. Verify And Release

- [x] 3.1 Add deterministic gesture, offscreen receiver, and recovery tests.
- [x] 3.2 Pass extension verification, real isolated-Chromium smoke, and strict
      OpenSpec validation for the individual candidates.
- [ ] 3.3 Verify the exact integrated commit, allocate a collision-free manifest
      version, package it, and record reload/promotion evidence separately.

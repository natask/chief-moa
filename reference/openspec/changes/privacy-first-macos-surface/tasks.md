## 1. Protocol prerequisite

- [x] 1.1 Land and smoke the canonical Aggie text-turn/event facade.
- [x] 1.2 Specify explicit semantic `ui.*` proposal kinds, digest binding,
      stale-state checks, approvals, and receipts before enabling native action.

## 2. Local read-only application

- [x] 2.1 Scaffold an ad-hoc-signed `MoaMac.app` QA bundle, pure core/AX
      packages, and deterministic fake-driven AX fixtures in an isolated
      worktree. Stable Developer ID signing remains a rollout task.
- [x] 2.2 Add explicit AX trust UI and the memory-only per-app observation grant.
- [x] 2.3 Add event-driven bounded snapshotting, secure-field suppression, local
      redaction, visible Pause/Stop scope, and complete revocation.
- [x] 2.4 Prove deterministic local observe/dismiss/expiry has no transport call
      and no raw AX persistence; leave real 60-second TCC QA to the isolated
      rollout gate.
- [x] 2.5 Add independently enabled focused-window ScreenCaptureKit capture with
      process revalidation, JPEG re-encoding, dimension/byte caps, and no
      whole-desktop or ungranted periodic capture.
- [x] 2.6 Add literal final-transcript insertion bound before Moa takes focus,
      with exact preview/confirmation, immediate AX revalidation, fsync-backed
      pending/terminal receipts, and zero-mutation rejection fixtures.

## 3. Explicit release

- [x] 3.1 Add the exact outbound payload/redaction preview and one-shot digest
      binding to a configured Aggie destination.
- [x] 3.2 Prove accepted bytes equal previewed bytes; dismissal sends nothing;
      excluded fields never reach a loopback gateway.
- [x] 3.3 Add the visible `trusted_server_15m` grant bound to one configured
      Chief Moa origin, evidence classes, screenshot state, and complete queued
      request revocation.
- [x] 3.4 Add authenticated `POST /v1/proactive/macos` with exact bounded AX and
      optional JPEG schema, no-tools provider routing, inert response, and no
      conversation/task/run/broker persistence.

## 4. Semantic actions and receipts

- [ ] 4.1 Implement the closed AX capability manifest and local validator.
- [ ] 4.2 Require confirmation and prove success plus stale, expired, mutated,
      wrong-surface, secure-value, and unknown-action rejection in the fixture.
- [ ] 4.3 Write durably committed pending/terminal hash-linked receipts and prove
      crash recovery, replay rejection, and absence of raw labels/values/context.

## 5. Packaging and rollout

- [x] 5.0 Create an ad-hoc-signed unsigned-distribution QA bundle and scan its
      source and binary for packaged destinations, private SkyLight/SLS symbols,
      AppleScript, coordinate input, and passive telemetry.
- [ ] 5.1 Build/notarize a stable hardened bundle with minimal entitlements and
      a rollback artifact; scan for prohibited frameworks/symbols/SDKs.
- [ ] 5.2 Run isolated-account TCC/privacy/manual QA without touching the user's
      live Accessibility grants or applications.
- [ ] 5.3 Promote only after preview, rollback, compatibility, idle-session, and
      smoke evidence passes.

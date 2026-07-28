# Surface Program Runtime Tasks

- [ ] 1. Define and validate `surface_program.v1`, execution profiles, scope,
      leases, cancel requests, events, and canonical receipts.
  - Acceptance: golden tests reject unknown versions, grant widening, stale
    profile revisions, expired leases, replayed cancellation sequences, and
    mismatched program digests.
- [ ] 2. Reuse the gateway agent harness for the remote program and persist one
      observable lifecycle joining remote work with local program receipts.
  - Acceptance: restart/reconcile smoke resumes orchestration without replaying
    a completed local effect.
- [ ] 3. Implement the browser JS/TS runner and profile-granted CDP broker,
      including raw `Runtime.evaluate`, scoped tabs/documents/origins, limits,
      inactive owned-tab leases, cancel, detach, cleanup, and receipts.
  - Acceptance: browser fixtures prove an allowed raw-CDP program can create and
    modify an inactive tab, a denied domain/origin cannot run, cancel detaches
    CDP, and cleanup never closes an unowned tab.
- [ ] 4. Implement `android_ir.v1` validation/interpreter over Accessibility and
      checked platform adapters with local permission/approval policy.
  - Acceptance: unit/instrumentation plus phone QA complete a multi-step app
    task; stale window/package, sensitive target, denied gesture/intent, cancel,
    and expiry each produce reason-coded receipts without unintended effects.
- [ ] 5. Add user-visible execution-profile inspection, grant/revoke controls,
      active run state, cancel, and receipt history to each owning surface.
  - Acceptance: a user can distinguish fixed tools, bounded programs, and broad
    developer profiles and revoke a grant before the next effect.
- [ ] 6. Build a shared evaluation suite and exact-artifact evidence matrix for
      deterministic contracts, adversarial evidence, lease races, cancellation,
      browser QA, Android QA, install/reload confirmation, and active smoke.
  - Acceptance: reports distinguish source verification, artifact creation,
    publication, installation/reload, and post-activation smoke.
- [ ] 7. Specify and prototype macOS/Windows/iOS adapters only after browser and
      Android semantics are measured; update the matrix with real limitations.
  - Acceptance: each advertised surface has an execution-language decision,
    authority map, unsupported list, cancel test, and receipt test.

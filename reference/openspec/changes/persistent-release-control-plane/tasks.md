## 1. Contract and persistence

- [ ] 1.1 Define canonical schemas for tenant, principal, role binding,
      delegation grant, application, surface, artifact, release bundle, channel
      head, assignment, proposal, evidence, and receipt.
- [ ] 1.2 Add tenant-scoped Postgres migrations with append-only promotion,
      assignment, delegation, and evidence events plus rebuildable current views.
- [ ] 1.3 Define artifact/evidence retention, backup, restore, and deletion policy.

## 2. Personal-first identity and authority

- [ ] 2.1 Create one owner tenant and authenticated human/device principals.
- [ ] 2.2 Implement roles and resource-scoped delegation grants; prove no
      self-grant, cross-tenant access, expired grant, or revoked grant succeeds.
- [ ] 2.3 Add recent-auth and two-person policy hooks without requiring two
      administrators in personal V0.

## 3. Release graph and frames

- [ ] 3.1 Register applications/surfaces and immutable artifacts/bundles.
- [ ] 3.2 Implement signed monotonic preview/stable channel heads.
- [ ] 3.3 Implement tenant/cohort/user/device assignments with visible precedence.
- [ ] 3.4 Record last-known-good stable and distinguish reassignment from actual
      native install/activation.

## 4. Runner and QA fabric

- [ ] 4.1 Define short-lived, job-scoped runner tokens and append-only artifact
      upload/evidence APIs with no promotion authority.
- [ ] 4.2 Add local and hosted runner registration/lease/heartbeat/retry semantics.
- [ ] 4.3 Bind existing Android, browser, web/gateway, macOS, and Windows checks to
      exact artifact/release ids in the common evidence contract.
- [ ] 4.4 Add real-device/browser QA receipts and reject QA for different bytes.

## 5. Promotion and fallback

- [ ] 5.1 Implement promotion proposals from app/control-plane navigation.
- [ ] 5.2 Integrate source-host review/merge as a separate optional phase.
- [ ] 5.3 Evaluate evidence/policy, atomically move a channel head, and record the
      exact before/after receipt and rollback target.
- [ ] 5.4 Implement preview-to-stable assignment switching and last-known-good
      fallback without claiming native rollback until platform receipts arrive.

## 6. Administration and customization

- [ ] 6.1 Add owner-managed administrators and release managers with scoped,
      expiring, revocable grants.
- [ ] 6.2 Add shared/team/personal channels without creating a channel for every
      user by default.
- [ ] 6.3 Define feature ids, dependencies, conflicts, compatibility, and policy.
- [ ] 6.4 Add an AI proposal adapter that cannot bypass deterministic resolution,
      QA, approval, signing, or platform installation.

## 7. Product surfaces and operations

- [ ] 7.1 Build the persistent two-frame Preview/Stable control surface with
      evidence, blockers, assignments, promotion, and fallback actions.
- [ ] 7.2 Add audit/history, pause, canary expansion, supersession, and recovery.
- [ ] 7.3 Prove backup/restore and lossless control-plane restart.
- [ ] 7.4 Integrate Chief Moa as the first application without embedding control-
      plane authority or signing credentials in its clients.

## First implementation ticket

- [x] V0.1 Implement a pure, persistence-neutral authority/channel domain module
      with deterministic tests for owner/admin grants, assignment precedence,
      preview switch, stable fallback, proposal authorization, and exact-artifact
      evidence binding. No HTTP routes, database writes, Git merge, build,
      publish, or install in this ticket.

## Second implementation ticket

- [x] V0.2.1 Add immutable multi-surface bundle, channel-head, assignment,
      install-receipt, and exact-release feedback records to the domain.
- [x] V0.2.2 Add a persistence-neutral service with assignment precedence,
      optimistic assignment sequences, idempotent channel assignments, and
      last-known-good stable fallback.
- [x] V0.2.3 Add memory and Postgres adapters for bundle/head reads and
      append-only assignment, install-receipt, and feedback writes.
- [x] V0.2.4 Add an additive Postgres migration for bundle, channel-head,
      assignment, install-receipt, and feedback records. Reject update, delete,
      and truncate operations.
- [x] V0.2.5 Add an authenticated, framework-neutral HTTP handler for release
      views, assignment, fallback, install receipts, and feedback. Derive tenant
      and actor identity from the injected authentication result.
- [x] V0.2.6 Keep assignment, install, activation, and smoke as separate states.
      Require exact assignment, bundle, surface, release, and artifact-digest
      binding for install receipts and feedback.
- [x] V0.2.7 Add an Android full-app release card for stable/preview selection,
      stable fallback, exact-release feedback, and explicit APK install review.
- [x] V0.2.8 Add a browser side-panel release card for stable/preview selection,
      stable fallback, exact-release feedback, and binary-reload-pending status.
- [x] V0.2.8a Add hash-only, device-bound release credentials with stable tenant
      identity, narrow device authority, Android backup exclusion, and
      Device-only release-route authentication.
- [x] V0.2.8b Package the gateway runtime, additive database bootstrap,
      health state, and release-database backup/restore path with the feature
      disabled for the first schema rollout.
- [x] V0.2.8c Add the least-authority repository publisher with exact source,
      artifact, evidence, sequence, and stable-promotion binding.
- [ ] V0.2.9 Run all release-control, Android, and browser verification. Fix any
      failure before creating release artifacts. Add one shared contract test
      that feeds the HTTP projection into both strict client parsers. Align
      Android lifecycle receipts with the service's accepted states.
      - [x] Release-control, gateway, Android unit/build, browser verify, and
        real-extension smoke checks pass; Android `activated` now matches the
        service lifecycle vocabulary.
      - [ ] One fixture must still be consumed directly by both the Java and
        JavaScript strict parsers, rather than only being compared with the HTTP
        projection in service tests.
- [ ] V0.2.10 Host the control-plane service behind production authentication,
      apply the migration to its separate database, seed immutable bundles and
      channel heads, and prove backup/restore and rollback.
- [ ] V0.2.11 Deploy the verified Android and browser clients. Smoke each client
      against the hosted endpoint and record installed, activated, and smoked
      receipts separately.

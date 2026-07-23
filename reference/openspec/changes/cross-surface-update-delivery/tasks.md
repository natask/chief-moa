## 1. Contract And Threat Model

- [ ] 1.1 Add canonical JSON fixtures and a shared release-envelope schema for
      immutable release manifests, signed channel heads, artifact descriptors,
      trust rotation, rollback authorization, and install receipts.
      Acceptance: equivalent inputs canonicalize to identical bytes; unknown
      semantic fields, invalid signatures, digest/size mismatch, and unknown
      signing keys fail closed in deterministic tests.
- [ ] 1.2 Add a threat-model note covering signing-key custody, replay,
      freeze/stale-head attacks, artifact substitution, signer rotation,
      downgrade, compromised distribution storage, and false release claims.
      Acceptance: every threat names prevention/detection and recovery evidence.
- [ ] 1.3 Decide where release/install evidence projects from canonical product
      events and define bounded retention for immutable artifacts/manifests.
      Acceptance: rebuilding the projection produces the same release state.

## 2. Shared Release Evaluator

- [ ] 2.1 Implement a platform-neutral evaluator for channel, cohort, pause,
      revocation, OS/architecture, version, and protocol compatibility.
      Acceptance: a golden matrix returns `up_to_date`, `eligible`, `deferred`,
      `incompatible`, `revoked`, and `verification_failed` with stable reasons.
- [ ] 2.2 Persist the highest accepted channel sequence and last-known-good
      release per installation without collecting the raw installation id.
      Acceptance: replayed heads are rejected; deterministic bucketing is stable
      across restarts; a valid signed rollback authorization is bounded by
      channel, release pair, and expiry.
- [ ] 2.3 Add two-phase publication: upload/fetch-verify immutable artifacts and
      manifest, then atomically advance a signed channel head.
      Acceptance: an interrupted upload never changes the visible channel head,
      and clients never observe a head pointing at missing bytes.
- [x] 2.4 Add typed evidence states and diagnostics that never infer a later
      state from an earlier one.
      Acceptance: fixtures prove CI success is not publication, upload is not
      installation, and install without relaunch smoke is not production-ready.
      Implemented by `scripts/release/release-evidence.mjs`; the first slice is
      an intentionally read-only projection and does not yet persist receipts.
      `.github/workflows/release-evidence.yml` runs the surface matrix on every
      relevant branch, and Android OTA CI now runs the full Gradle `check`
      (including the coverage ratchet) plus `assembleDebug` before packaging.
      The first full run also forced the pre-Android-14 Quick Settings launch
      fallback behind a narrowly annotated legacy helper while retaining the
      required PendingIntent path on Android 14+.

## 3. Android Adapter — Primary Validation Lane

- [ ] 3.1 Map the existing Android OTA metadata/artifact into the shared
      envelope without breaking the current authenticated endpoints.
      Acceptance: an old client retains its existing update behavior while a
      new client validates the common signature and selects the same APK.
- [ ] 3.2 Verify APK package id, version code, size, digest, and signing
      certificate continuity before package-installer handoff.
      Acceptance: one mutated APK and one unexpected-signer APK are rejected
      before installer launch; the currently installed app remains usable.
- [ ] 3.3 Record post-relaunch installed/smoke receipts and distinguish user
      cancellation, installer rejection, install success, and smoke success.
      Acceptance: real-phone QA installs an eligible development-channel build,
      relaunches it, and reads back the expected release id/version.
- [ ] 3.4 Exercise pause and forward-moving recovery with a higher-version build
      from known-good source.
      Acceptance: a non-installed client stops seeing the paused build, and a
      test phone confirms the corrective release after relaunch without losing
      compatible local state.

## 4. Browser Adapter — Primary Validation Lane

- [ ] 4.1 Emit a release record from the existing verified extension package,
      binding extension id, manifest version, package digest, git SHA, and
      supported browser/store matrix.
      Acceptance: source changes cannot publish under an unchanged version and
      the fetched archive digest matches the immutable manifest.
- [ ] 4.2 Harden the unpacked development adapter so reload confirmation reads
      the loaded manifest version after the signal window.
      Acceptance: smoke fixtures produce separate `confirmed`, `blocked`, and
      `unverified` results; a fire-and-forget poke alone never reports success.
- [ ] 4.3 Add the first user-distribution store adapter without bypassing store
      policy.
      Acceptance: store submission/publication evidence is separate from a real
      browser's installed-version evidence; unavailable store credentials leave
      a package artifact and a plain blocker.
- [ ] 4.4 Exercise store or development-channel supersession/recovery.
      Acceptance: the bad version is paused/superseded and a real browser reads
      back the corrective loaded version before recovery is marked complete.

## 5. macOS Adapter — Secondary Platform Lane

- [ ] 5.1 Review maintained updater/distribution options and record license,
      maintenance, signature model, notarization support, delta/full-package
      behavior, user-consent flow, sandbox compatibility, and rollback limits.
      Acceptance: one mechanism is selected with a documented rejection reason
      for alternatives; no custom updater engine is introduced.
- [ ] 5.2 Build the thin adapter from the shared envelope/channel decision to the
      selected updater feed/package format.
      Acceptance: deterministic tests reject wrong bundle id, team id, digest,
      channel sequence, architecture, or protocol range without invoking install.
- [ ] 5.3 Produce and inspect a Developer ID-signed, notarized, stapled artifact.
      Acceptance: signature identity and notarization checks pass against the
      exact manifest digest. Missing credentials stop at built/packaged with a
      blocker and no readiness claim.
- [ ] 5.4 Perform real supported-Mac install, relaunch, smoke, pause, and recovery
      QA.
      Acceptance: receipts prove the installed release before and after
      recovery. Until this passes, macOS remains not production-ready.

## 6. Windows Adapter — Secondary Platform Lane

- [ ] 6.1 Review MSIX/App Installer and maintained updater alternatives for
      license, maintenance, signature model, user/enterprise policy, elevation,
      architecture, delta/full-package behavior, and rollback limits.
      Acceptance: one mechanism is selected with documented rejection reasons;
      no custom elevated installer is introduced.
- [ ] 6.2 Build the thin adapter from the shared envelope/channel decision to the
      selected signed package/update format.
      Acceptance: deterministic tests reject wrong package identity, publisher,
      digest, channel sequence, architecture, or protocol range before install.
- [ ] 6.3 Produce and inspect a signed Windows package.
      Acceptance: native signature and publisher identity match the manifest.
      Missing credentials stop at built/packaged with a blocker and no readiness
      claim.
- [ ] 6.4 Perform real supported-Windows install, relaunch, smoke, pause, and
      recovery QA.
      Acceptance: receipts prove the installed release before and after
      recovery. Until this passes, Windows remains not production-ready.

## 7. Operations And Safe Promotion

- [ ] 7.1 Extend the repository deploy entrypoint with committed-artifact
      release lanes while preserving dirty-target refusal and per-surface
      verification.
      Acceptance: dry-run output names exact release id, channel, artifact
      digest, evidence present, evidence missing, rollback plan, and whether the
      channel head would advance.
      Progress: `scripts/deploy.sh plan <evidence.json>` now evaluates a single
      immutable candidate across every named surface and reports exact digest,
      publication/readiness booleans, and missing evidence without mutation.
      Artifact discovery and signed channel advancement remain open.
- [ ] 7.2 Add release pause, cohort expansion, supersession, and key-rotation
      runbooks.
      Acceptance: each operation creates a higher signed sequence, is auditable,
      and has a deterministic smoke that does not touch an active channel.
- [ ] 7.3 Prove the active-promotion gate separately for each surface and cohort:
      preview/artifact smoke, rollback, no interrupted work, state
      compatibility, and backup/restore where user data is involved.
      Acceptance: missing evidence blocks channel advancement and is reported
      plainly.
- [ ] 7.4 Update architecture and surface documentation when implementation
      introduces the shared release primitive and adapters.
      Acceptance: documented ownership matches code and no platform is described
      as ready beyond its evidence state.

## 8. Final Verification And Release Evidence

- [ ] 8.1 Run strict OpenSpec validation for this change.
- [ ] 8.2 Run shared envelope/evaluator tests and each touched surface's default
      verification command.
- [ ] 8.3 Commit each coherent platform lane with a Conventional Commit and
      create its preview/release artifact.
- [ ] 8.4 Promote only the channels/cohorts whose active-promotion gates pass;
      smoke the promoted target or record the exact blocker and artifact path.

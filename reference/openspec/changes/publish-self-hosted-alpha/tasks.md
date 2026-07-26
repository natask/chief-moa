# Tasks

No task below is authorized until the user aligns with the proposal and selects
the root license.

## 0. Alignment And Isolation

- [ ] 0.0 `[in-progress: bounded first slice; no implementation claimed]`
  Record only the proposed release shape as one decision row in `proposal.md`,
  with alternatives and user-confirmation state; leave license, client, and
  version decisions untouched.
  Acceptance: `proposal.md` contains one release-shape row with proposed value,
  alternatives, and `awaiting_user_confirmation` status.
- [ ] 0.1 Confirm the release shape, root license, first required client, and
      prerelease version in `proposal.md`.
- [ ] 0.2 Create a clean release branch/worktree from the intended base commit;
      do not include unrelated voice or source-decomposition work.

Acceptance: the release candidate starts from a named clean commit and the four
release decisions are recorded as confirmed.

## 1. Legal And Privacy Gate

- [ ] 1.1 Add the selected root license and reconcile the existing browser
      component license plus bundled asset provenance.
- [ ] 1.2 Run a full-history secret scan and a release-tree privacy scan without
      printing secret values; rotate/revoke findings before publication.
- [ ] 1.3 Prove ignored local state, recordings, database dumps, OTA signing
      material, credentials, and generated private artifacts are absent from the
      release tree and artifacts.

Acceptance: a release audit records tool/version, commit, finding counts,
remediation state, and asset/license disposition without containing secrets.

## 2. Honest Public Entry Point

- [ ] 2.1 Rewrite the top-level quickstart around the single supported Compose
      + browser-extension golden path.
- [ ] 2.2 Separate maintainer production operations from self-host user docs and
      replace personal IPs, paths, project ids, and domains where they imply a
      reusable default.
- [ ] 2.3 Add `SECURITY.md`, alpha support/limitations, code of conduct, issue
      forms, pull-request template, and release checklist.
- [ ] 2.4 State clearly which features are stable enough to try, experimental,
      build-from-source, or not yet available.

Acceptance: an unauthenticated first-time reader can identify the product,
audience, trust boundary, supported path, costs/credentials, limitations, and
where to report a security issue without following internal planning docs.

## 3. Clean-Machine Self-Host Proof

- [ ] 3.1 Validate Compose configuration with generated throwaway values.
- [ ] 3.2 Start an isolated preview stack with separate volumes and prove health,
      protected-route rejection without a token, protected-route success with a
      token, Postgres persistence, deterministic text turn, and teardown.
- [ ] 3.3 Prove backup and scratch restore without touching the active gateway.
- [ ] 3.4 Repeat the documented quickstart on a clean machine or fresh VM using
      only public documentation.

Acceptance: one evidence note records the exact commit, commands, non-secret
results, elapsed setup time, teardown, and every deviation from the docs.

## 4. First Client Artifact

- [ ] 4.1 Verify and smoke the browser extension from the release commit.
- [ ] 4.2 Bump the extension version, package it, calculate a SHA-256 checksum,
      and verify install, connection, one protected text turn, update, and
      rollback.
- [ ] 4.3 Decide Android inclusion from evidence. If included, build the APK,
      prove signer continuity and phone install/rollback, then record manual QA;
      otherwise label Android build-from-source/experimental for this release.

Acceptance: every attached client artifact can be traced to the release commit
and has a checksum plus an honest verified/published/installed state.

## 5. Publish And Verify

- [ ] 5.1 Review the exact public tree and generated artifacts from a logged-out
      perspective.
- [ ] 5.2 After explicit user approval, change repository visibility to public.
- [ ] 5.3 Create the approved prerelease tag and GitHub prerelease with release
      notes, known limitations, artifacts, checksums, migration compatibility,
      and rollback instructions.
- [ ] 5.4 Execute the public quickstart using public URLs and file any discovered
      defects as narrow tickets.

Acceptance: a logged-out user can access the repository and release, verify the
artifact checksum, complete the documented golden path, and find the support and
security channels.

## 6. Post-Release Learning Loop

- [ ] 6.1 Add three to five labeled good-first issues from known documentation,
      smoke, or pure-logic gaps.
- [ ] 6.2 Record onboarding failures and support load for the first release
      window; prioritize only failures that block the supported golden path.
- [ ] 6.3 Decide the next release boundary: Android artifact hardening, device
      auth, voice reliability, or managed hosted onboarding.

Acceptance: the next milestone is selected from observed alpha usage rather
than assumed completeness.

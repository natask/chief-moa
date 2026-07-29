## 1. Persist authority

- [ ] 1.1 Add an additive record for the Android stable head, global channel
      sequence, source lineage, application id, signer, and artifact digest.
- [ ] 1.2 Add bootstrap/reconciliation for the exact currently served stable APK
      and fail closed when its provenance cannot be established.
- [ ] 1.3 Add immutable promotion and rejection receipts.

## 2. Guard publication

- [ ] 2.1 Resolve and pin the protected source-policy revision from the remote.
- [ ] 2.2 Reject normal candidates that do not descend from both the stable
      source revision and protected source-policy revision.
- [ ] 2.3 Enforce application id, signer, canonical product identity, artifact
      digest, parent release, evidence, and rollback checks.
- [ ] 2.4 Commit the head through atomic compare-and-swap before changing the
      served stable pointer; make stale writers harmless.
- [ ] 2.5 Add the persistent, expiring, exact-candidate recovery authorization.

## 3. Verify and adopt

- [ ] 3.1 Test an old branch with a higher timestamp/version code and prove it
      cannot move stable.
- [ ] 3.2 Test concurrent publishers and prove exactly one expected-head update
      succeeds.
- [ ] 3.3 Test ancestry, remote freshness, signer, app-id, identity, evidence,
      rollback, recovery authorization, and no-partial-mutation failures.
- [ ] 3.4 Publish a device-reachable preview, smoke the exact candidate, then
      promote only after the active-promotion gate passes.
- [ ] 3.5 Record the stable promotion and installed/activated/smoked phone states
      as separate exact-artifact receipts.

# Tasks

## 1. Canonical progress control

- [x] 1.1 Add a deterministic generator that imports every checkbox from every
      active, non-archive OpenSpec `tasks.md`.
      Acceptance: validation reports identical source and ledger row counts,
      unique stable identifiers, and no missing or duplicate checkbox.
- [x] 1.2 Generate `progress-ledger.md` with status, evidence, next action,
      acceptance, blocker/authority, and duplicates fields on every row.
      Acceptance: a clean regeneration produces no diff.
- [x] 1.3 Split the identified false-complete claims while preserving their
      implemented sub-slices.
      Acceptance: token-backed live extension checks, approval events,
      import/projection rebuild, subproject records, and mainline consolidation
      are visibly incomplete.
- [x] 1.4 Select one bounded first slice for every program with zero checked
      source tasks without claiming that implementation occurred.
      Acceptance: each such program has exactly one task tagged
      `in-progress: bounded first slice; no implementation claimed`.

## 2. macOS credential evidence

- [x] 2.1 Register zero-Keychain implementation evidence from commit
      `f6ec029f616cbedd48b9a50b20946639e34ae66c`, its tests/static scan, and the
      installed/dist executable SHA-256.
      Acceptance: the ledger records exact immutable evidence without claiming
      runtime launch verification.
- [ ] 2.2 `[implemented-unverified]` Verify a user-operated `MoaMac.app` launch
      and authenticated turn remains prompt-free without any prompt-capable
      diagnostic command.
      Acceptance: a dated manual QA receipt records launch, connect, one turn,
      disconnect, relaunch, and absence of authorization/Keychain prompts.
- [ ] 2.3 Reconcile old backup copies of `MoaMac.app` without deleting anything
      until the user approves exact targets.
      Acceptance: each discovered backup has a path, digest, disposition, and
      explicit authority for any removal.
- [ ] 2.4 Audit any separate `MOA.app` bundle as a separate product scope.
      Acceptance: its path, bundle identifier, executable digest, credential
      behavior, and owner are recorded independently from `MoaMac.app`.
- [ ] 2.5 Classify historical documents and archived changes as
      non-authoritative context.
      Acceptance: no ledger row becomes complete solely from historical prose.

## 3. Independent acceptance

- [ ] 3.1 Obtain independent verification of the generated ledger and corrected
      source claims.
      Acceptance: a verifier who did not produce this change records the
      generator command, counts, invariant results, and any discrepancies.

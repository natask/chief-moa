# Design

## Canonical input

The generator scans `reference/openspec/changes/*/tasks.md`. Paths containing an
`archive` segment are excluded. Each Markdown checkbox becomes exactly one
ledger row with a stable identifier derived from its source path and normalized
task text; source line remains a separate locator and may change without
changing the identifier.

The generated ledger is the progress view. The source task remains the
requirement text. Archive notes, scratch files, release narratives, and chat are
non-authoritative unless their exact evidence is registered on a ledger row.

## Status model

- `verified_complete`: exact evidence and an independent verification receipt
  both exist.
- `implemented_unverified`: implementation or source completion is claimed but
  independent acceptance is absent.
- `in_progress`: a bounded next slice is selected or underway; this does not
  claim implementation.
- `blocked`: progress requires named authority, credentials, consolidation, or
  external state.
- `not_started`: no implementation evidence is registered.

Only `verified_complete` counts as complete. All other statuses require a
smallest next action, acceptance check, and any blocker/authority boundary.

## Evidence rules

Evidence must identify an immutable commit, artifact digest, deterministic test
receipt, or dated runtime receipt. A checked source box by itself is not
evidence. Producer tests are useful evidence but do not replace independent
verification. Duplicate requirements remain separate source rows and link to
one another through the `duplicates` field; they are never silently dropped.

The zero-Keychain change is tied to commit
`f6ec029f616cbedd48b9a50b20946639e34ae66c`, the Apple tests/static scan named
by that change, and the installed/dist binary SHA-256
`624068bf65ae520bf695594591ea9791105d49faf08e6ec5b2cb7f57478ec4a2`.
That proves byte identity and implementation evidence, not a prompt-free runtime
launch. Runtime launch therefore remains `implemented_unverified`. The older
backup-copy risk and any separate `MOA.app` bundle are distinct scopes and must
not be inferred safe from `MoaMac.app`. Historical docs are non-authoritative.

## No-prompt verification invariant

Without the user's explicit approval for the exact command and purpose, agents
MUST NOT run prompt-capable or privileged verification, including:

- `sfltool`, `sudo`, or tools that invoke macOS Authorization Services;
- `security` generic-password/Keychain reads, writes, deletes, or Keychain UI;
- Keychain Access automation, TCC reset/change tools, installer/admin helpers,
  background-item mutation, or comparable commands that may request a password,
  biometric approval, or security consent.

Use non-privileged alternatives: repository/source inspection, static scans,
ordinary file metadata and hashes, process lists, application logs already
available to the user, deterministic unit/integration tests, and user-operated
manual QA. If those cannot prove the claim, record `blocked` or
`implemented_unverified`; never escalate silently.

## Deterministic validation

`generate-progress-ledger.mjs --write` regenerates the ledger.
`generate-progress-ledger.mjs` validates that:

1. every active checkbox appears exactly once;
2. stable identifiers are unique;
3. every incomplete row has a next action and acceptance check;
4. `verified_complete` always has exact evidence and independent verification;
5. old generic placeholder phrases, exact requirement-as-acceptance
   tautologies, and generic one-word acceptance claims are rejected;
6. each next action retains task-specific operation/scope tokens; and
7. the checked-in ledger exactly matches deterministic generation.

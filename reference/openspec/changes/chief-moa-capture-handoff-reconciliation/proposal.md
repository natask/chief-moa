# Chief Moa Capture And Handoff Reconciliation

## Why

Chief Moa accumulated working assistant, dictation, note, capture, intent, and
agent paths while the product boundary kept changing in conversation. That made
it possible to mistake Branch Continue's notebook or Switchboard's intent
kernel for Chief Moa itself, or to remove the existing assistant while adding
capture.

## Product Outcome

Chief Moa remains the any-Surface intake product with four deliberate paths:
responding assistant, literal dictation, inert voice/video-note capture, and an
explicit handoff to Switchboard-owned intent execution. It does not own Branch
Continue's branch tree or Switchboard's canonical projects and intents.

## First Slice

- Preserve the evidence-backed intent ledger in `intent-ledger-20260803.md`.
- Finish recoverable raw voice notes without adding model or agent work to
  capture.
- Expose the stored notes in one full Surface.
- Implement a versioned idempotent Chief-to-Switchboard handoff
  that records external identity and receipts without duplicating ownership.

## Non-Goals

- No assistant removal or browser role-selector revival.
- No Branch Continue note-tree implementation in this repository.
- No new canonical intent store in Chief Moa.
- No automatic dispatch from capture, screen evidence, or model output.
- No production promotion without the repository's preview, rollback,
  compatibility, drain, and smoke gates.

## Success Criteria

The acceptance contract is the final section of `intent-ledger-20260803.md`.
The four paths remain independently testable, and a captured note cannot start
work until the user explicitly hands it off.

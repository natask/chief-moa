# Repair contract: voice draft store final-audit-9

## Outcome

Close every independently reproduced persisted-authority, physical-store, and
atomic-publication blocker in `final-audit-9.md` without weakening any of the
53 existing guarantees. This is one module-owned repair, but its tests and
implementation must keep the three classes below explicit so one cannot mask
another.

## A. Canonical mutation and evidence authority

- Replace latest-only proof with a canonical global mutation sequence or hash
  chain covering create, append, every control/recovery transition, claim, and
  mark-sent. Validate exactly one mutation per predecessor revision, contiguous
  successors, and legal state at every step. An append outside `capturing` is
  invalid even if segment and transition sub-histories are separately ordered.
- Retain an immutable full create request/result root through every later
  mutation and validate it before create replay lookup. Changing any create
  authority after park/append/recovery/claim/terminal state must fail closed.
- Bind the complete append-only user action-key set and its order/cardinality
  to the chain/checkpoint, including keys whose display history was truncated.
  Keep system-recovery authority separate and bounded.
- Bind current partial transcript plus update timestamp to the exact latest
  content mutation. Define unchanged-transcript and terminal-clear behavior.
- Verify every segment digest against its exact PCM slice, and bind the ordered
  segment/content aggregate to the verified whole-file digest.
- Anchor pre-cleanup byte/duration/segment counts so a discarded tombstone
  cannot be rewritten after audio deletion.
- If any display history remains bounded, persist a cryptographic prefix
  checkpoint with exact boundary state/revision and append-only authority;
  never accept a finite untracked prefix or a digest recomputed solely from
  already mutable current fields.

Required regressions include the exported-API reproductions from findings 1-4:
cross-family revision swap/state replay; create-key mutation after later
operations; every evicted action-hash removal/replacement; transcript/time,
joint segment/request digest, and discard-count changes.

## B. Exact physical root and replay-index representation

- Define and enforce one exact store-root schema: authoritative draft
  directories, canonical replay index, and only explicitly bounded lock/temp
  scaffolding. Unknown regular files/directories/symlinks/special nodes or
  malformed temps fail before mutation and are preserved as evidence.
- Make `status()` account for all recognized physical entries/bytes and never
  report a green quota in the presence of an unknown artifact.
- Reject duplicate textual JSON object members before materialization, or move
  the replay index to a canonical unique entry sequence/table whose persisted
  bytes and key uniqueness are verified. Preserve O(1) keyed lookup, count and
  encoded-byte caps, keyed 410, 507 admission backpressure, and index-first
  crash reconciliation.
- Add low-quota unknown-root cases and duplicate replay draft/create keys in
  both textual orders. Rejection must not rewrite/delete the evidence.

## C. Ambiguous atomic publication reconciliation

- Distinguish `not_published`, `published_verified`, and
  `publication_durability_unknown` when rename succeeds but parent fsync fails.
- On unknown durability, read the exact target back through the bound
  directory and compare the complete intended record before lease/index
  cleanup decisions.
- Reconcile the authoritative record and exact physical capture lease before
  returning any duplicate receipt and before later create/append/transition.
  Published parked/terminal state releases its prior lease; published capturing
  resume retains or exactly reacquires its new lease. Never return success for
  capturing state without its matching lease.
- Apply equivalent ambiguity handling to cleanup records and replay-index
  publication.
- Add same-process post-rename parent-fsync cases for pause, park, resume,
  send-ready, discard, claim, mark-sent, cleanup finalization, and index
  publication, plus restart proof.

## Constraints

- Own only `gateway/lib/voice-drafts.js`, its focused test/smoke, and this
  lane's durable notes.
- Do not expose routes, change provider/model/tool behavior, touch other
  surfaces, access live data, commit, merge, preview, or deploy.
- Do not loosen caps, delete unknown artifacts, discard replay authority, or
  use restart as the only repair.

## Verification

```sh
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
node gateway/scripts/smoke-voice-drafts.js
git diff --check
```

Run no-index whitespace checks for every untracked lane file. Record exact
test counts and effect evidence in `repair-audit-10-result.md`. A different
fresh auditor must return `PASS` before commit or integration.

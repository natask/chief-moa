# Tasks

## 1. Boundary and store domain

- [x] 1.1 Add a pure, frame-aligned `resultEndOffset` to PCM-byte-span resolver
  with duplicate, malformed, regressing, and out-of-range coverage.
- [x] 1.2 Add predecessor-readable durable span, claim, attempt, result, and
  revision-activation records scoped to owner/session/turn/audio digest.
- [x] 1.3 Add recovery tests proving completed paid spans are not submitted
  again and ambiguous attempts obey the bounded retry policy.

## 2. Rolling worker and snapshots

- [x] 2.1 Enqueue immutable spans only from streaming Chirp `isFinal` boundaries
  and flush the exact remaining PCM tail asynchronously at commit.
- [x] 2.2 Run batch Chirp work under bounded global/per-owner concurrency,
  pending-span, duration/byte, retry, and claim-attempt limits.
- [x] 2.3 Serialize only the contiguous corrected prefix and publish monotonic
  whole-turn `finalized_text` plus `unsealed_text` snapshots.
- [x] 2.4 Append and activate only a nonempty complete corrected revision while
  preserving revision 0 and the execution-revision reference.

## 3. Privacy, compatibility, and observability

- [x] 3.1 Recheck audio retention, ownership, generation/digest, deletion, and
  provider availability before every audio read and paid call; fail soft.
- [x] 3.2 Keep legacy clients compatible and keep all rolling fields/events
  additive and capability-advertised.
- [x] 3.3 Add content-free queue, cost, retry, skip, and correction-latency
  metrics plus an operator control that stops new enqueue independently.
- [ ] 3.4 Capability-gate Android rolling events and bind them to exact
  owner/user, session, branch, turn, message, transcript sequence, and batch
  revision identity.
- [ ] 3.5 Apply prefix events from their authoritative whole text without
  overlap inference. Apply complete corrections only to the exact retained
  finalized user message, never assistant text or the current capture, and
  announce the update without moving accessibility focus.
- [x] 3.6 Capability-gate browser prefix revisions, bind them to exact
  session/branch/turn/canonical-user-message authority, reject stale sequence
  or batch revisions, and keep canonical History plus Copy monotonic.
- [x] 3.7 Send explicit retained-audio reconciliation consent only for normal
  non-incognito browser voice sessions and prove private/non-audio omission.

## 4. Verification and rollout

- [ ] 4.1 Prove live partial and final turn/reasoning/TTS completion never wait
  for a blocked rolling worker.
- [x] 4.2 Prove exact span coverage, non-overlap, out-of-order worker completion,
  monotonic publication, empty-result protection, crash recovery, and privacy
  deletion with deterministic gateway tests.
- [ ] 4.2a Add Android tests for stale, wrong-identity, out-of-order, duplicate,
  and missing-tail events, plus exact finalized-user-message targeting and
  focus-preserving accessibility behavior.
- [x] 4.2b Add deterministic browser tests for a corrected rolling prefix plus
  live tail, out-of-order delivery, wrong authority, immutable same-revision
  History, and Copy's corrected-text source.
- [ ] 4.3 Run `cd gateway && npm run check`, the repo-wide source-size policy,
  and strict OpenSpec validation.
- [ ] 4.4 Create an isolated preview with rollback evidence, then enable a
  duration-limited cohort and record measured quality benefit and provider cost
  before active promotion.

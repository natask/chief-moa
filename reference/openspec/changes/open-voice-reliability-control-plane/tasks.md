# Tasks

## Research and contract

- [x] Recover the Emdash/Superset reference pair and StarSling name.
- [x] Verify current open-source/source-available licenses and YC identities.
- [x] Review generic and voice-native observability, testing, replay, and CI
  optimization products using dated primary sources.
- [x] Define the voice-specific wedge, semantic model, trust boundary,
  no-gaming contract, open-source posture, and Chief Moa dogfood path.
- [ ] Interview five browser-voice infrastructure leads, collect three
  consented redacted examples of the same server-emitted/user-dead-air failure,
  and compare Hamming, LiveKit, and one open competitor on those incidents.
- [ ] Recruit two external design partners willing to instrument a browser pilot.

The two tasks above block implementation beyond a Moa-only draft.

## Moa-only MVP

- [ ] Draft, but do not freeze, session/turn/server-write/endpoint-receipt/
  endpoint-playout/transport/calibration/release records for the Chief Moa
  browser and Node gateway only.
- [ ] Map existing Chief Moa provider events and diagnosis records into that
  schema without adding an external exporter or changing canonical product data.
- [ ] Define and fault-test event/queue/spool/exporter CPU, memory, disk, I/O,
  event-rate/size, timeout, overflow, and voice-latency budgets.
- [ ] Add bounded browser endpoint-observed playout and network observations
  behind metadata-only privacy defaults and short-lived, revocable, write-only,
  session/origin/schema/nonce-bound ingestion tickets.
- [ ] Build one local synchronized browser/gateway timeline.
- [ ] Prove the timeline changes one server-only diagnosis, then validate setup
  effort and incident value with both design partners.

Only that evidence unlocks the portable evidence plane.

## Portable evidence plane

- [ ] Freeze version 1 portable semantics only after the MVP gate passes.
- [ ] Add metadata-only cohort queries for p50/p95/p99 with sample counts,
  release/config filters, and sparse-tail warnings.
- [ ] Version and emit each percentile policy's population, inclusion rules,
  minimum sample count, estimator, confidence/error method, and missing/
  censored/rejected/dropped/clock-uncertain treatment.
- [ ] Add offered/admitted/completed/rejected/timed-out/dropped turn rates,
  active concurrency, admission/queue delay, saturation, rate-limit, and
  backpressure measures without dropping failed attempts from denominators.

## Replay and pull-request gate

- [ ] Define the portable replay manifest, artifact hashing, retention, access,
  redaction, and deletion-lineage contract.
- [ ] Define metadata, derived-content, and raw-artifact classes; prove encrypted
  raw exceptions, managed deletion, external-export revocation/tombstones, and
  restore-safe tombstone processing.
- [ ] Convert one explicitly retained Chief Moa failure into a deterministic
  component fixture and verify deletion propagation.
- [ ] Add a separate read-only pull-request workflow for voice regression; it
  must not reuse or modify the write-capable VPS deployment workflow, use
  `pull_request_target`, receive secrets/OIDC/production access, or grant write
  permission to candidate execution. Pin actions by SHA and isolate any narrow
  check-write reporter behind a sanitized artifact.
- [ ] Compare baseline and candidate on one frozen cohort across latency,
  task/response quality, cost, interruptions/errors, and safety.
- [ ] Have an independent coordinator sign a hashed benchmark manifest with
  paired samples, immutable collection/aggregation/evaluator versions, minimum
  sample/confidence rules, and every failed/timed-out/dropped/censored attempt.
- [ ] Add a sealed holdout with hidden labels, an immutable all-candidate trial
  ledger, and a versioned repeated-trial/multiple-hypothesis correction.
- [ ] Add negative fixtures for truncation, call dropping, telemetry suppression,
  retention reduction, timeout relabeling, denominator/status manipulation,
  judge manipulation, and weakened safety checks.

## Improvement agent and productization

- [ ] Add a read-only diagnosis agent that ranks cohorts and cites exact evidence
  and uncertainty.
- [ ] Permit one bounded candidate change in an isolated worktree only after the
  fixed-corpus gate is stable; enforce capability/path/egress restrictions and
  use a separate branch-only PR principal.
- [ ] Run isolated preview, backup/restore, compatibility, drain/resume,
  session-stickiness, independent canary, rollback, and post-promotion smoke
  evidence before any production optimization.
- [ ] Measure capture overhead, event volume, queue/spool drops, query cost,
  storage cost, and evaluator agreement before choosing hosted infrastructure or
  pricing.
- [ ] Before an open-source claim, publish SPDX licenses and a component plus
  dependency/codec/model license inventory; require OSI-approved licenses for
  every component called open source, label source-available/proprietary parts,
  and prove no mandatory hosted dependency or phone-home plus a
  hosted-export-to-self-hosted-restore path.
- [ ] Extract the Apache-2.0 core only after the MVP and customer-evidence gates
  pass.

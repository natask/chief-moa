# Tasks

No product implementation or Fabro execution is authorized until the proposal,
acceptance matrix, and workflow authority split are aligned with the user.

## 0. Architecture Alignment

- [ ] 0.0 `[in-progress: bounded first slice; no implementation claimed]` Draft
  one objective-boundary row for an Android spoken turn, naming start state,
  useful end state, deterministic evidence, real-device evidence, and authority;
  do not define the full cross-surface matrix in this slice.
  Acceptance: the reviewed row distinguishes deterministic from real-device
  evidence and leaves user-operated authority explicit.
- [ ] 0.1 Confirm that the primary objective is fluent and useful voice across
  Android, browser, gateway/provider, and deployed operations.
- [ ] 0.2 Align on the five result states: `passed`, `failed`, `blocked`,
  `not_measured`, and `stale`; do not add a generic skipped state.
- [ ] 0.3 Confirm the first usefulness journeys and which real-device/browser
  steps require user operation.
- [ ] 0.4 Confirm paid/live provider evaluation consent and budget remain
  explicit per run.

Acceptance: the user approves or revises the objective, matrix, and authority
split before implementation begins.

## 1. Objective Manifest And Reducer

- [ ] 1.1 Add a schema and checked-in `fluent-useful-v1` objective manifest
  binding objective revision, candidate, matrix cells, evaluators, evidence,
  freshness, invalidation, safety, and promotion requirements.
- [ ] 1.2 Implement a pure manifest validator and completion reducer over
  fixture artifacts.
- [ ] 1.3 Prove missing and mismatched evidence remains not measured or stale,
  and prove a green deterministic lane cannot satisfy a real-surface cell.

Acceptance: one command deterministically renders the complete matrix and its
overall incomplete/complete state from fixtures, with exact evidence refs.

## 2. Evaluation-Only Fabro Workflow

- [ ] 2.1 Add and validate the `voice-intent-completion` Fabro workflow with
  gateway, provider, Android, browser, usefulness, trust-audit, and reduction
  lanes.
- [ ] 2.2 Adapt existing checks and evaluations to emit versioned evidence
  artifacts without changing their core evaluator behavior.
- [ ] 2.3 Make absent device access, live-provider consent, credentials, or
  external service report an explicit blocker; never auto-pass a manual node.

Acceptance: a dry run produces an honest matrix, including `not_measured` or
`blocked` real-surface cells, and does not edit code or deploy.

## 3. Durable Work And Evidence State

- [ ] 3.1 Represent objective, evaluation, diagnosis, repair, and operations
  nodes in the existing gateway work graph.
- [ ] 3.2 Store immutable attempt/evidence artifacts with idempotent keys and
  objective/candidate/evaluator bindings.
- [ ] 3.3 Expose an authenticated projection answering overall state, remaining
  cells, blockers, attempts, and artifact refs.

Acceptance: the loop can stop and resume across Fabro runs without losing the
original intent or treating old candidate evidence as current.

## 4. Cross-Surface Usefulness And QA Receipts

- [ ] 4.1 Freeze the first five usefulness journeys and their deterministic,
  human-observed, and action/run-receipt predicates.
- [ ] 4.2 Add bounded Android real-device QA receipts for capture, transcript,
  first audio/playback, interruption, visible result, approvals, and recovery.
- [ ] 4.3 Add bounded browser QA receipts for the same applicable observations,
  including endpoint-observed receipt/queue/playout evidence.
- [ ] 4.4 Prove an LLM score cannot replace deterministic outcomes or local
  action/run receipts.

Acceptance: the same candidate has comparable but source-honest usefulness and
fluency evidence on Android and browser.

## 5. Diagnosis, Repair, And Re-Evaluation

- [ ] 5.1 Reduce each failed cell into a bounded repair contract with exact
  evidence, allowed paths/capabilities, acceptance predicate, and re-evaluation
  set.
- [ ] 5.2 Run repairs only in isolated branches/worktrees and make objective,
  evaluator, corpus, reducer, evidence, and promotion-policy files read-only.
- [ ] 5.3 Bind repaired output to a new candidate and invalidate only declared
  dependent evidence before re-evaluation.

Acceptance: one seeded failure progresses through diagnosis, bounded repair,
and affected-cell re-evaluation without allowing the candidate to weaken its
test.

## 6. Operational Completion

- [ ] 6.1 Add verification, commit, preview, and active-promotion-gate nodes
  using existing repo deployment paths.
- [ ] 6.2 Require rollback, no-interruption, compatibility, and backup/restore
  evidence where applicable before promotion.
- [ ] 6.3 Require promoted-target phone/browser/gateway smoke evidence bound to
  the promoted candidate before final completion.
- [ ] 6.4 Run the first objective until complete, explicitly stopped, or blocked
  by a durable artifact naming the missing authority/external condition.

Acceptance: Fabro cannot reach an operationally complete result unless every
required cell and post-promotion check passes for the same candidate.

## 7. Verification

- [ ] 7.1 `openspec validate voice-intent-completion-loop --strict`.
- [ ] 7.2 `fabro validate .fabro/workflows/voice-intent-completion/workflow.fabro`
  after the workflow exists.
- [ ] 7.3 Run focused objective/reducer/work-graph tests and the existing voice
  contract checks required by the aligned manifest.
- [ ] 7.4 Run one real Android turn, one real browser turn, and the explicitly
  approved live-provider sample set; retain pass/fail/blocker evidence.

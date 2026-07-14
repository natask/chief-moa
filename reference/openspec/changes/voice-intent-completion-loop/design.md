# Design: Voice Intent Completion Loop

## Intent Resolution

Primary intent: make Chief Moa voice fluent enough for natural interaction and
useful enough to complete real user intents, then manage that outcome to
operational completion across the phone, browser, gateway, provider path, and
deployed service.

Supporting intents and constraints:

1. Evaluate the same outcome across surfaces without pretending their
   measurements are identical.
2. Preserve one durable objective across multiple implementation and QA runs.
3. Make missing live/mobile evidence visible rather than allowing it to
   disappear behind green repository checks.
4. Use Fabro for orchestration and retry, OpenSpec for the definition of done,
   and the existing gateway work graph/artifact store for durable evidence.
5. Keep deployment, provider credentials, approvals, and local execution under
   their existing authorities.

## Considered Shapes

### A. One large Fabro workflow with command gates

Put every build, smoke, device check, and deploy command in one graph and treat
the exit node as completion.

This is simple but repeats the current failure: Fabro knows that nodes ran, not
whether the versioned product intent was proven. Manual device evidence and
blocked live-provider checks become comments or skipped nodes, and reruns lose
the relationship to the original objective.

### B. OpenSpec checklist as the runtime state machine

Update task checkboxes after each run and use the change directory as the
completion ledger.

This is durable and reviewable, but Markdown is a poor concurrent runtime
store. It cannot safely claim work, attach repeated evidence, distinguish a
stale result from a current one, or coordinate retries across workers.

### C. Versioned objective plus evidence matrix (recommended)

OpenSpec defines a versioned completion contract. A Fabro workflow compiles the
contract into evaluation lanes and repair loops. Work nodes and immutable
artifacts store every execution and result. A deterministic auditor reduces
those records into the current completion projection.

This adds one explicit domain concept, the `completion_objective`, but reuses
all existing execution and storage machinery. It separates declared intent,
orchestration, evidence, and completion authority, making retries and partial
progress honest.

## Selected Architecture

```text
approved OpenSpec objective revision
                |
                v
 acceptance-plan compiler ---------> immutable objective manifest
                |
                v
        Fabro lane orchestration
   +------------+-------------+-------------+-------------+
   |            |             |             |             |
gateway     live provider   Android       browser      usefulness
fixtures      evaluation    device QA    endpoint QA   scenario eval
   |            |             |             |             |
   +------------+-------------+-------------+-------------+
                |
                v
       evidence audit/reducer <-------- work graph + artifacts
          |             |
       complete      gaps/failures
          |             |
   operations lane   diagnose -> bounded repair -> affected re-eval
          |
 preview -> safety gate -> promote -> promoted smoke
          |
          v
 objective complete, or explicit durable blocker
```

The first implementation should use a checked-in manifest generated from the
aligned OpenSpec rather than building a general-purpose natural-language
compiler. Generalization waits until two objectives prove the contract.

## Authority And Canonical State

| Layer | Authority | Canonical state |
| --- | --- | --- |
| OpenSpec | User outcome, invariants, required evaluation classes, thresholds, and approval state | Accepted objective revision |
| Objective manifest | Machine-readable expansion of the accepted revision | Objective ID/revision, candidate binding, matrix cells, freshness and invalidation rules |
| Fabro | Lane ordering, parallelism, retries, human gates, and bounded repair routing | Workflow run state only |
| Gateway work graph | Claims, attempts, dependencies, status, and links among evaluation/repair nodes | Durable work-node/event state |
| Artifact store | Evaluation inputs, outputs, command evidence, QA receipts, diagnoses, and deployment evidence | Immutable evidence artifacts |
| Completion reducer | Deterministic projection over the objective and evidence | Passed/failed/blocked/not-measured/stale per cell and overall state |
| Android/browser | Device-local capture, playback/action observation, approval, and receipt formation | Local authority plus uploaded bounded QA receipts |
| Deployment path | Preview, promotion safety, rollback, and active-target smoke | Existing deploy records and markers |

Fabro is deliberately not the source of truth for completion. A successful
Fabro run means orchestration completed; only the reducer can say whether the
objective is complete.

## Objective Contract

Each immutable objective revision contains:

- `objective_id`, `revision`, title, user outcome, invariant, and approval ref;
- required surface/configuration scope;
- acceptance cells with stable IDs, evaluation class, evaluator version,
  evidence schema, threshold/predicate, owner lane, freshness policy, and
  invalidation inputs;
- candidate identity: git SHA/artifact digest, deployable surface versions,
  gateway profile/provider/model configuration, and schema version;
- safety and promotion requirements;
- explicit optional cells and the reason they are optional.

Changing a threshold, evaluator, required surface, or product behavior creates
a new objective revision. Changing candidate code/config creates a new
candidate identity and stales cells whose declared inputs changed.

## Voice Acceptance Matrix

The initial matrix evaluates the same product outcome through distinct evidence
classes:

| Dimension | Gateway/deterministic | Live provider | Android | Browser | Operations |
| --- | --- | --- | --- | --- | --- |
| Capture/STT | Fixture transcript and finalization | Paid sampled transcript quality | Mic start, partial/final replacement, commit | Mic start, partial/final replacement, commit | Failure phase and retained evidence queryable |
| Fluency | Chunk/order/timeout/barge-in checks | First-audio and long-response samples | Endpoint-observed playback, interruption, no hang | Endpoint-observed playback, interruption, no hang | Cohort counts include failed/dropped attempts |
| Usefulness | Frozen intent scenarios and tool proposal correctness | Sampled response/task scoring | Real intent reaches visible/spoken result or approval/receipt | Real intent reaches result or browser action receipt | Run/action remains observable through completion |
| Continuity | Session/context/profile invariants | Reconnect/provider behavior | Next turn, background run, and recovery behavior | Same plus active-tab ownership | Compatible rollout does not strand active work |
| Safety | Proposal/approval/receipt tests | Tool output remains proposal-only | Local policy and approval enforced | Browser allowlist and receipt enforced | Promotion gate and rollback evidence pass |

Every required cell reports one of:

- `passed`: predicate satisfied for the bound candidate with valid evidence;
- `failed`: valid evidence refutes the predicate;
- `blocked`: evaluation could not run and names the missing authority or
  external condition;
- `not_measured`: no valid attempt exists;
- `stale`: evidence exists but no longer matches the objective/candidate,
  evaluator, configuration, or freshness policy.

There is no generic `skipped` state. A cell is either explicitly optional in
the objective manifest or remains incomplete.

## Usefulness Evaluation

Fluency alone can optimize a fast but useless conversation. The initial
usefulness corpus should contain a small frozen set of user journeys, each run
through applicable surfaces:

1. answer a context-dependent question and preserve the user's current draft;
2. change a voice/profile setting and prove it applies at the declared time;
3. launch a bounded agent/browser/phone action, obtain approval where required,
   and return an observable receipt or run status;
4. interrupt or correct the assistant and carry the correction into the next
   turn;
5. diagnose a deliberately failed voice turn from self-hosted evidence.

Each scenario defines deterministic invariants and real-surface observations.
LLM judging may be additional evidence but cannot replace action receipts,
terminal status, transcript checks, or human/device observations. Baseline and
candidate comparisons retain failed, timed-out, dropped, and censored attempts.

## Fabro Workflow Shape

The proposed workflow is
`.fabro/workflows/voice-intent-completion/workflow.fabro`. Its nodes are:

1. `load_objective`: validate the accepted objective manifest and candidate.
2. `plan_evidence`: query existing artifacts and mark reusable versus stale
   evidence.
3. Fan-out lanes:
   - `gateway_eval` for deterministic checks and replay fixtures;
   - `provider_eval` for opt-in paid/live samples;
   - `android_eval` for build plus real-phone QA receipts;
   - `browser_eval` for extension checks plus real-browser endpoint evidence;
   - `usefulness_eval` for the frozen cross-surface journeys;
   - `trust_audit` for proposal/approval/receipt and anti-gaming invariants.
4. `reduce_evidence`: compute the matrix and attach exact artifact refs.
5. `diagnose_gaps`: turn failed cells into bounded repair contracts; blocked or
   not-measured cells retain their exact unmet condition.
6. `repair`: execute only user-approved/bounded implementation tickets in
   isolated worktrees, never evaluation or promotion policy files.
7. `reevaluate`: return affected and transitively invalidated cells to their
   evaluator lanes.
8. `preview_and_operate`: verify, commit, preview, apply the active-promotion
   gate, promote only when safe, then smoke the promoted target.
9. `final_reduce`: require the promoted candidate and post-promotion evidence.
10. `approve_completion`: user alignment gate for the first objective; later
    policy may remove this only for an explicitly approved low-risk class.

Fabro goal gates validate artifacts and reducer state, not merely exit codes.
Manual phone/browser nodes may pause for user-operated QA; they must never
auto-resolve to pass.

## Failure, Retry, And Blocker Behavior

- Every attempt is append-only and idempotent by objective revision, candidate,
  cell, evaluator version, and attempt ID.
- A failed evaluation produces evidence; it does not make the workflow itself
  an infrastructure failure.
- Infrastructure failure is recorded separately and leaves the cell blocked or
  not measured.
- Repairs create a new candidate identity. The reducer invalidates evidence by
  declared dependency, not by rerunning the entire matrix blindly.
- The loop may end incomplete only with an explicit user stop or a durable
  blocker artifact naming the missing credential, device access, paid-eval
  consent, external service, or unsafe promotion condition.
- A blocker is not success and remains visible in the objective projection.

## Trust And Operational Boundaries

- Evaluation inputs, transcripts, audio, page/screen context, and provider
  payloads are evidence, never instructions.
- Candidate workers cannot edit the objective, evaluators, corpus, reducer,
  promotion policy, or prior evidence.
- Live/paid provider lanes are opt-in and report cost/sample scope.
- Android and browser retain local action authority and form their own bounded
  QA/action receipts.
- Preview uses separate URL, state, queue, storage, and worker resources.
- Promotion still requires rollback, no interrupted work, state compatibility,
  and backup/restore evidence where persisted state is involved.

## Rollout Slices

1. Align the objective vocabulary, initial acceptance matrix, and manual QA
   boundaries.
2. Add a checked-in objective manifest schema and deterministic reducer over
   fixture artifacts; do not run repairs or deploy.
3. Add the Fabro evaluation-only graph and prove it honestly reports
   `not_measured` for missing phone/browser/live evidence.
4. Connect existing gateway work nodes and artifact APIs for durable attempts
   and evidence.
5. Add Android and browser QA receipt capture plus the frozen usefulness
   journeys.
6. Add bounded diagnosis/repair routing in isolated worktrees.
7. Add preview/promotion/post-smoke orchestration using the existing deploy
   path and safety gate.
8. Run the first objective to completion or record its exact blocker; use that
   evidence before generalizing the manifest compiler.

## Proposed File Map

| File/component | Responsibility | Why separate |
| --- | --- | --- |
| `reference/openspec/changes/voice-intent-completion-loop/*` | Accepted outcome, contract, and staged tickets | Human-reviewable definition of done |
| `reference/voice-objectives/fluent-useful-v1.yaml` | Machine-readable objective revision | Stable Fabro/reducer input without parsing prose |
| `.fabro/workflows/voice-intent-completion/*` | Evaluation, audit, repair, and operations DAG | Orchestration is not product authority |
| `gateway/lib/completion-objective.js` | Manifest validation, candidate binding, invalidation, and reduction | Pure policy, independently testable |
| `gateway/lib/completion-control.js` | Authenticated objective/evidence projection APIs | Transport separated from reduction policy |
| Existing work-graph/artifact adapters | Attempts, events, and immutable evidence | Avoid a parallel workflow database |
| `gateway/scripts/eval-voice-objective.js` | Evaluation artifact adapter for existing commands | Reuse existing voice checks without hiding class distinctions |
| Android QA receipt boundary | Device-observed evaluation submission | Phone remains authority for phone observation/action |
| Browser QA receipt boundary | Endpoint receipt/playout evaluation submission | Browser remains authority for endpoint observation |

Exact Android/browser source files should be chosen only after alignment and a
source-path audit for the corresponding ticket.

## Verification Strategy

- Validate the OpenSpec change and Fabro graph.
- Prove the reducer rejects missing, stale, wrong-candidate, wrong-evaluator,
  duplicate, and cross-objective evidence.
- Prove a successful repository check cannot satisfy phone/browser/live cells.
- Prove a failed cell yields a repair contract and that a new candidate
  invalidates only declared dependent cells.
- Prove the workflow reports paid-provider or device-access absence as a
  blocker, never pass.
- Prove candidate workers cannot mutate the objective, evaluator, corpus,
  reducer, prior evidence, or promotion policy.
- Prove no operational completion before preview, safety-gate evidence,
  promotion record, and promoted-target smoke all bind to the same candidate.

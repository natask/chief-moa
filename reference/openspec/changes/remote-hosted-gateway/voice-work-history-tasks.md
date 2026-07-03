# Voice Work-History Control Plane Tasks

## Lane Split

### Workflow / Docs

Outcome: stable OpenSpec contract for voice-driven work history, evidence,
proposals, claims, receipts, acceptance criteria, and smoke checks.

Files:

- `reference/openspec/changes/remote-hosted-gateway/voice-work-history-control-plane.md`
- `reference/openspec/changes/remote-hosted-gateway/voice-work-history-tasks.md`

Boundary: documentation and product contract only; no runtime source changes.

Acceptance: the contract names the spoken operations, durable evidence records,
proposal/claim/receipt policy, and smoke checks.

Verification: `fabro validate .fabro/workflows/vps-agent-control-plane/workflow.fabro`

Deploy target or blocker: non-deployable docs-only change; deployment is
blocked unless a later implementation changes a deployable surface.

### Gateway

Outcome: later implementation stores and projects tasks, runs, evidence,
deployment records, feedback, and UI-open requests.

Files: out of scope for this ticket.

Boundary: gateway stores and routes proposals; it does not execute harnesses,
open UIs, run browser CDP, press Android controls, or apply active deployments.

Acceptance: covered by later gateway smoke checks in sections 1-7 below.

Verification: later `cd gateway && npm run check` plus endpoint smokes.

Deploy target or blocker: out of scope for this ticket.

### Worker / Execution Machine

Outcome: later implementation claims queued runs, records before/after evidence,
executes harnesses locally, and receipts results.

Files: out of scope for this ticket.

Boundary: worker connects outbound to the gateway and owns repo edits, build
commands, harness credentials, and run receipts.

Acceptance: a queued run remains inert until a worker claims it.

Verification: later worker-claim smoke.

Deploy target or blocker: out of scope for this ticket.

### Android And Browser Clients

Outcome: later implementation claims `ui.open` and other local tool requests,
validates local authority, performs local UI handoff, and posts receipts.

Files: out of scope for this ticket.

Boundary: clients own local UI, permissions, browser/page authority, phone
actions, and receipts.

Acceptance: gateway-created UI requests do nothing until a client claims and
receipts them.

Verification: later Android/browser smoke.

Deploy target or blocker: out of scope for this ticket.

### Deployment Control Plane

Outcome: later implementation records preview, artifact, and applied deployment
state and keeps active promotion explicit.

Files: out of scope for this ticket.

Boundary: deployment-link queries read records; deployment requests are
proposals. Applying a deployment requires explicit user promotion and linked
backup/restore/smoke evidence.

Acceptance: preview links and active URLs are distinguishable, and no voice
query applies a deployment by implication.

Verification: later deployment-link smoke and active-promotion smoke.

Deploy target or blocker: out of scope for this ticket.

## 1. Contract And Event Types

- [ ] 1.1 Define `work_task`, `repo_snapshot_ref`, `diff_ref`,
  `verification_artifact`, `deployment_record`, `user_feedback`, and `ui.open`
  request/receipt schemas as product-event payloads.
- [ ] 1.2 Add idempotency, causation, correlation, actor, authority, blob refs,
  and artifact refs to every mutating record.
- [ ] 1.3 Document projection rebuild expectations for status, deployment link,
  and run detail views.

Acceptance: a reviewer can answer which event/artifact records reconstruct the
before/after story for one agent run.

Smoke check: append fixture events for one run, rebuild/read projections, and
query the run's before snapshot, after snapshot, diff, verification, deployment,
and feedback records by id.

## 2. Voice Intent To Work Task / Run

- [ ] 2.1 Route voice/text work requests through the broker before creating
  work records.
- [ ] 2.2 Create a `work_task` for durable user intent and a queued/proposed
  `agent_run` only when the route decision selects execution work.
- [ ] 2.3 Return a concise spoken/display response naming the task id, run id,
  status, and whether a worker has claimed it.

Acceptance: "start a gateway fix run" creates a broker event, route decision,
task, and queued run without starting execution.

Smoke check: send a deterministic voice/text turn, then assert no `run.claimed`
or `run.started` event exists until a worker claim fixture is posted.

## 3. Status And History Queries

- [ ] 3.1 Add status query behavior for active, blocked, completed, failed, and
  waiting-on-user work.
- [ ] 3.2 Summarize latest run events, verification artifacts, feedback, and
  deployment records from projections.
- [ ] 3.3 If fresh local state is required, enqueue a status-refresh proposal
  for the owning worker/client instead of inventing a result.

Acceptance: "what is running" and "what changed in that run" answer from stored
events/artifacts and do not launch new work.

Smoke check: load fixtures for queued, active, blocked, and completed runs, then
verify the status response includes the correct ids, states, and blocking
reasons.

## 4. Feedback Attachment And Control Requests

- [ ] 4.1 Store every follow-up utterance as `user_feedback` with the source
  turn, broker event, target refs, transcript, summary, intent, and status.
- [ ] 4.2 Attach feedback to active tasks/runs without cancellation unless the
  user explicitly asks to pause or cancel.
- [ ] 4.3 Model pause/cancel/redirect as `run_control_request` proposals that
  the owning worker must claim and receipt.

Acceptance: a spoken correction appears in the target run history and the run
continues unless the feedback intent is explicit cancellation or pause.

Smoke check: attach one correction and one cancellation request to an active
run; assert the correction only creates feedback/attached events, while
cancellation creates a claimable control request.

## 5. Worker Evidence Recording

- [ ] 5.1 Require workers to record a before `repo_snapshot_ref` after claim and
  before edits.
- [ ] 5.2 Require workers to record after `repo_snapshot_ref`, `diff_ref`, and
  verification artifacts before completion.
- [ ] 5.3 Store command output, patches, screenshots, and logs as artifacts or
  blob refs with redaction status instead of chat-only summaries.

Acceptance: every completed code-changing run can show what repo state it
started from, what changed, what verification ran, and what state it ended on.

Smoke check: simulate a worker run with fixture snapshots, diff, and verification
artifact; assert a status/detail query reconstructs the before/after evidence.

## 6. Deployment Links And Promotion Safety

- [ ] 6.1 Store deployment requests separately from deployment records.
- [ ] 6.2 Record preview, artifact-only, applied, failed, and superseded
  deployment states with target, commit, URLs, smoke refs, and control-plane id.
- [ ] 6.3 Require explicit current-turn promotion before applying active
  deployments, switching active URLs, calling Master Orch apply, or restarting
  active services.
- [ ] 6.4 Link active promotion records to read-only backup, restore check, and
  post-apply smoke artifacts.

Acceptance: asking for a deployment link returns known preview/active/artifact
links or queues a deploy request; it never applies or restarts by implication.

Smoke check: query latest deployment links with fixture preview and applied
records; assert the response distinguishes them and no apply event is appended.

## 7. Client UI Open Requests

- [ ] 7.1 Resolve `task`, `run`, `diff`, `verification`, `deployment`, and
  `feedback` records to safe route refs and URLs.
- [ ] 7.2 Enqueue `tool_request` records for `ui.open` addressed to a target
  client or surface class.
- [ ] 7.3 Require the client to claim, validate, open or reject locally, and
  post a receipt.

Acceptance: asking "open that run on my phone" creates a request that remains
pending until an Android client claims and receipts it.

Smoke check: enqueue a UI-open request, post a client claim and receipt fixture,
then assert the gateway records completion without performing any local UI
action itself.

## 8. Verification Package

- [ ] 8.1 Add a voice create smoke for task/run creation.
- [ ] 8.2 Add a worker evidence smoke for before/after snapshots, diff, and
  verification artifacts.
- [ ] 8.3 Add a status smoke over queued, active, blocked, completed, and failed
  projections.
- [ ] 8.4 Add a feedback smoke for non-interrupting correction and explicit
  cancellation request.
- [ ] 8.5 Add a deployment-link smoke that proves preview/applied separation and
  no implicit promotion.
- [ ] 8.6 Add a UI-open smoke that proves claim and receipt behavior.

Acceptance: the smoke suite proves voice can drive the control plane while every
mutating operation remains proposal, claim, and receipt based.

Verification: run the relevant gateway/workflow smoke commands added by the
implementation, then run the workflow validation for the owning Fabro workflow.

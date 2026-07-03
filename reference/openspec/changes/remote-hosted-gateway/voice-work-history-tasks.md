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

Outcome: the gateway stores and projects tasks, runs, evidence, deployment
records, feedback, and UI-open requests. Implemented 2026-07-03.

Files:

- `gateway/lib/work-history.js` (event-sourced control-plane store + projections)
- `gateway/lib/work-history-intent.js` (deterministic spoken-operation parser)
- `gateway/server.js` (`/v1/work-history/*` routes, broker-first turn entry,
  `POST /v1/voice/turns` interception before the legacy dispatch branch)
- `gateway/scripts/smoke-work-history-intent.js` (unit smoke, runs in `npm run check`)
- `gateway/scripts/smoke-work-history.js` (end-to-end smoke, `npm run smoke:work-history`)

Boundary: gateway stores and routes proposals; it does not execute harnesses,
open UIs, run browser CDP, press Android controls, or apply active deployments.

Acceptance: covered by the gateway smoke checks in sections 1-8 below.

Verification: `cd gateway && npm run check` and
`cd gateway && npm run smoke:work-history` (both passing 2026-07-03).

Deploy target or blocker: gateway deploy via `bash scripts/deploy.sh gateway`
after merge; not deployed from this branch.

### Worker / Execution Machine

Outcome: later implementation claims queued runs, records before/after evidence,
executes harnesses locally, and receipts results.

Files: the worker daemon is still out of scope; the gateway claim/evidence API
it will call is live (`POST /v1/work-history/runs/claim`,
`POST /v1/work-history/runs/:id/{events,snapshots,diffs,verifications}`,
`POST /v1/work-history/controls/claim`, `POST /v1/work-history/controls/:id/receipt`).

Boundary: worker connects outbound to the gateway and owns repo edits, build
commands, harness credentials, and run receipts.

Acceptance: a queued run remains inert until a worker claims it (enforced and
smoke-tested gateway-side).

Verification: worker-claim behavior is covered by
`gateway/scripts/smoke-work-history.js` using a simulated worker; the real
worker daemon smoke comes with the worker-pull implementation.

Deploy target or blocker: out of scope for this ticket.

### Android And Browser Clients

Outcome: later implementation claims `ui.open` and other local tool requests,
validates local authority, performs local UI handoff, and posts receipts.

Files: client-side handling is still out of scope; the gateway queues `ui.open`
through the existing cross-device tool hub (`/v1/tool/requests` claim/receipt),
smoke-tested with a simulated Android client.

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

- [x] 1.1 Define `work_task`, `repo_snapshot_ref`, `diff_ref`,
  `verification_artifact`, `deployment_record`, `user_feedback`, and `ui.open`
  request/receipt schemas as product-event payloads.
  (`gateway/lib/work-history.js`; `ui.open` reuses the tool-request/receipt
  records of the cross-device tool hub.)
- [x] 1.2 Add idempotency, causation, correlation, actor, authority, blob refs,
  and artifact refs to every mutating record. (Idempotency keys derive from the
  source turn id + operation, so voice retries return the original records.)
- [x] 1.3 Document projection rebuild expectations for status, deployment link,
  and run detail views. (ARCHITECTURE.md "Voice Work-History Control Plane";
  enforced by the rebuild check in `scripts/smoke-work-history-intent.js`,
  which folds a second store instance from the same event log.)

Acceptance: a reviewer can answer which event/artifact records reconstruct the
before/after story for one agent run.

Smoke check: append fixture events for one run, rebuild/read projections, and
query the run's before snapshot, after snapshot, diff, verification, deployment,
and feedback records by id.

## 2. Voice Intent To Work Task / Run

- [x] 2.1 Route voice/text work requests through the broker before creating
  work records. (`storeBrokerMessage` runs before every control-plane intent;
  the queued run links the broker event id and top route decision id.)
- [x] 2.2 Create a `work_task` for durable user intent and a queued
  `agent_run` only when the route decision selects execution work. (Explicit
  create/queue phrasing queues a `wr_` run; the legacy `agent_run`
  classification for non-explicit phrasing still starts local harness runs —
  flipping that default to queued is a named follow-up below.)
- [x] 2.3 Return a concise spoken/display response naming the task id, run id,
  status, and whether a worker has claimed it.

Acceptance: "start a gateway fix run" creates a broker event, route decision,
task, and queued run without starting execution.

Smoke check: send a deterministic voice/text turn, then assert no `run.claimed`
or `run.started` event exists until a worker claim fixture is posted.

## 3. Status And History Queries

- [x] 3.1 Add status query behavior for active, blocked, completed, failed, and
  waiting-on-user work. (`GET /v1/work-history/status` + spoken scopes
  running/changed/failed/waiting.)
- [x] 3.2 Summarize latest run events, verification artifacts, feedback, and
  deployment records from projections. ("what did <run> change" answers from
  before/after snapshots, the diff ref, and the latest verification.)
- [ ] 3.3 If fresh local state is required, enqueue a status-refresh proposal
  for the owning worker/client instead of inventing a result. (Follow-up: the
  current answer names only stored state and never invents; the refresh
  proposal is not implemented yet.)

Acceptance: "what is running" and "what changed in that run" answer from stored
events/artifacts and do not launch new work.

Smoke check: load fixtures for queued, active, blocked, and completed runs, then
verify the status response includes the correct ids, states, and blocking
reasons.

## 4. Feedback Attachment And Control Requests

- [x] 4.1 Store every follow-up utterance as `user_feedback` with the source
  turn, broker event, target refs, transcript, summary, intent, and status.
- [x] 4.2 Attach feedback to active tasks/runs without cancellation unless the
  user explicitly asks to pause or cancel. (Targetless corrections land on the
  most recently active run.)
- [x] 4.3 Model pause/cancel/redirect as `run_control_request` proposals that
  the owning worker must claim and receipt. (`run.control_requested` ->
  `run.control_claimed` -> `run.control_receipted`; only an applied cancel
  receipt appends `run.canceled`.)

Acceptance: a spoken correction appears in the target run history and the run
continues unless the feedback intent is explicit cancellation or pause.

Smoke check: attach one correction and one cancellation request to an active
run; assert the correction only creates feedback/attached events, while
cancellation creates a claimable control request.

## 5. Worker Evidence Recording

- [x] 5.1 Require workers to record a before `repo_snapshot_ref` after claim and
  before edits. (Gateway API + evidence smoke; hard enforcement lands in the
  worker daemon, which must post the before snapshot before editing.)
- [x] 5.2 Require workers to record after `repo_snapshot_ref`, `diff_ref`, and
  verification artifacts before completion. (`recordDiff` refuses to link
  without both snapshots; the evidence smoke reconstructs the full story.)
- [x] 5.3 Store command output, patches, screenshots, and logs as artifacts or
  blob refs with redaction status instead of chat-only summaries.
  (`patch_artifact_ref`, `stdout_ref`/`stderr_ref`, `extra_refs`, and
  `redaction_status` fields; summaries stay speakable.)

Acceptance: every completed code-changing run can show what repo state it
started from, what changed, what verification ran, and what state it ended on.

Smoke check: simulate a worker run with fixture snapshots, diff, and verification
artifact; assert a status/detail query reconstructs the before/after evidence.

## 6. Deployment Links And Promotion Safety

- [x] 6.1 Store deployment requests separately from deployment records.
  (`deployment.requested` vs `deployment.recorded` events; distinct ids.)
- [x] 6.2 Record preview, artifact-only, applied, failed, and superseded
  deployment states with target, commit, URLs, smoke refs, and control-plane id.
- [x] 6.3 Require explicit current-turn promotion before applying active
  deployments. (An applied record without `explicit_promotion: true` is
  rejected; voice queries and deploy requests never apply anything.)
- [x] 6.4 Link active promotion records to read-only backup, restore check, and
  post-apply smoke artifacts. (`backup_record_ref` and `restore_check_ref` are
  hard-required for applied records; `smoke_artifact_ref` is recorded when the
  deploy control plane provides it.)

Acceptance: asking for a deployment link returns known preview/active/artifact
links or queues a deploy request; it never applies or restarts by implication.

Smoke check: query latest deployment links with fixture preview and applied
records; assert the response distinguishes them and no apply event is appended.

## 7. Client UI Open Requests

- [x] 7.1 Resolve `task`, `run`, `diff`, `verification`, `deployment`, and
  `feedback` records to safe route refs and URLs. (`resolveUiRoute` reads only
  durable records; deployment routes prefer stored preview/active URLs.)
- [x] 7.2 Enqueue `tool_request` records for `ui.open` addressed to a target
  client or surface class. (Cross-device tool hub; when no client is
  reachable the gateway answers with the link as text instead.)
- [x] 7.3 Require the client to claim, validate, open or reject locally, and
  post a receipt. (Gateway-side flow smoke-tested with a simulated Android
  client; the real Android/extension `ui.open` handlers are a client lane
  follow-up.)

Acceptance: asking "open that run on my phone" creates a request that remains
pending until an Android client claims and receipts it.

Smoke check: enqueue a UI-open request, post a client claim and receipt fixture,
then assert the gateway records completion without performing any local UI
action itself.

## 8. Verification Package

- [x] 8.1 Add a voice create smoke for task/run creation.
- [x] 8.2 Add a worker evidence smoke for before/after snapshots, diff, and
  verification artifacts.
- [x] 8.3 Add a status smoke over queued, active, blocked, completed, and failed
  projections.
- [x] 8.4 Add a feedback smoke for non-interrupting correction and explicit
  cancellation request.
- [x] 8.5 Add a deployment-link smoke that proves preview/applied separation and
  no implicit promotion.
- [x] 8.6 Add a UI-open smoke that proves claim and receipt behavior.

All six live in `gateway/scripts/smoke-work-history.js`
(`npm run smoke:work-history`); the parser/store/rebuild unit smoke
`gateway/scripts/smoke-work-history-intent.js` runs inside `npm run check`.

## Follow-Ups (out of the first slice)

- [ ] Flip the legacy voice `agent_run` classification to queued-by-default so
  non-explicit phrasing ("fix the small issue") also queues instead of starting
  a local harness run; gate the flip behind an env flag during migration.
- [ ] Route Gemini Live tool calls (`launch_agent_run`) through the control
  plane so streaming sessions also create queued runs.
- [ ] Implement the status-refresh proposal (3.3) for stale local state.
- [ ] Ship the worker daemon from the worker-pull contract to claim queued runs
  from the execution machine and post evidence automatically.
- [ ] Add Android and browser-extension `ui.open` claim handlers.

Acceptance: the smoke suite proves voice can drive the control plane while every
mutating operation remains proposal, claim, and receipt based.

Verification: run the relevant gateway/workflow smoke commands added by the
implementation, then run the workflow validation for the owning Fabro workflow.

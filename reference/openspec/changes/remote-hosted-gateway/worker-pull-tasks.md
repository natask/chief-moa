# Worker Pull Tasks

This task ledger turns the bounded worker-pull contract into implementation
tickets. It preserves the lane split required for the VPS agent control-plane
workflow and keeps active deployment promotion blocked until a human approves
it.

## Lane Split

Lane:
Workflow/docs

Outcome:
Define the worker-pull execution contract, request/response shapes, failure
modes, and first smoke gate.

Files:
`reference/openspec/changes/remote-hosted-gateway/worker-pull-contract.md`,
`reference/openspec/changes/remote-hosted-gateway/worker-pull-tasks.md`

Boundary:
No source mutation, no service restart, no active deployment promotion.

Acceptance:
Contract includes worker token scope, registration, claim transport, heartbeat,
event streaming, result reporting, cancellation, retry behavior, session/branch
artifact/deployment linkage, no inbound worker port, and no unrestricted shell
from VPS to worker.

Verification:
`fabro validate .fabro/workflows/vps-agent-control-plane/workflow.fabro`

Deploy target or blocker:
Docs-only lane. No deployable target. Active promotion remains blocked.

## Implementation Tickets

### 1. Worker Credential Store And Registration

Lane:
Gateway

Outcome:
Add owner-approved worker registration and hashed worker tokens distinct from
device tokens.

Files:
`gateway/server.js`, a gateway worker credential store module if split out,
Postgres schema/migration files when the run store moves behind Postgres, and
local JSON fallback files for `local` mode.

Boundary:
Worker tokens authorize only claim, heartbeat, event append, result completion,
and cancel observation for scoped runs. They do not create runs, call provider
APIs, read unrelated user data, register devices, or apply deployments.

Acceptance:
An authenticated owner creates a one-use registration code; a worker registers
with a manifest; the gateway returns a plaintext worker token once; the stored
credential is hashed and scoped to a worker id, user id, harness allowlist,
project allowlist, and max parallel claim count.

Verification:
Gateway unit or smoke test covers registration success, duplicate setup code
failure, expired setup code failure, and revoked token rejection.

Deploy target or blocker:
Gateway preview only after verification. Active promotion blocked by human gate.

### 2. Run Linkage And Queue Metadata

Lane:
Gateway

Outcome:
Extend queued agent runs with worker lease fields and explicit session, branch,
work, artifact, and deployment references.

Files:
`gateway/server.js`, agent-run store module if extracted, product event
substrate adapter only if new event types need explicit mapping, and schema
files when Postgres run storage is introduced.

Boundary:
The gateway stores inspectable linkage. It does not turn deployment refs into
active deployment actions and does not put raw shell/env data into run records.

Acceptance:
Every queued run can expose `session_id` or legacy `conversation_id`,
`branch_id`, `turn_id`, `broker_event_id`, `route_decision_id`,
`context_pack_ref`, `work_node_id`, input/output artifact refs, deployment
candidate refs, and `apply_allowed: false` by default.

Verification:
Gateway smoke creates a run through the existing `/v1/agent/runs` path and reads
it back with linkage present and no active process started in worker-pull mode.

Deploy target or blocker:
Gateway preview only after verification. Active promotion blocked by human gate.

### 3. Long-poll Claim Endpoint

Lane:
Gateway

Outcome:
Add `POST /v1/agent/workers/claim` that leases one queued run to one authorized
worker.

Files:
`gateway/server.js`, worker/run store helpers, gateway smoke test scripts.

Boundary:
Claim payload includes bounded harness and context data only. It never includes
`command`, `args`, `shell`, raw env, raw credentials, or an arbitrary absolute
path for the gateway to force on the worker.

Acceptance:
A worker with matching harness/project scopes can claim one queued run; a second
worker cannot claim the same leased run; a worker without scope receives a
bounded error; an idle worker receives a no-work response after the long-poll
wait.

Verification:
Gateway smoke covers claim success, no-work response, unauthorized token,
out-of-scope harness/project, and duplicate claim conflict.

Deploy target or blocker:
Gateway preview only after verification. Active promotion blocked by human gate.

### 4. Heartbeat, Event, And Result Endpoints

Lane:
Gateway

Outcome:
Add worker-owned heartbeat, event streaming, and terminal result reporting for
the current claim.

Files:
`gateway/server.js`, run event store helpers, product event substrate mapping if
needed, smoke test scripts.

Boundary:
Only the current claim can mutate a run through these endpoints. Events are
bounded, idempotent by event id, and appended to the existing run lifecycle.
Result data links artifacts and deployment candidates but cannot apply a
deployment.

Acceptance:
The worker extends the lease with heartbeat, appends `started` and `stdout`
events, reports a terminal result, and stale claim writes cannot overwrite the
run.

Verification:
Gateway smoke verifies heartbeat lease extension, duplicate event id
idempotency, terminal result update, stale claim rejection, and product event
mirroring where configured.

Deploy target or blocker:
Gateway preview only after verification. Active promotion blocked by human gate.

### 5. Cancellation And Retry Semantics

Lane:
Gateway and worker runtime

Outcome:
Make existing run cancellation observable to workers and define lease-expiry
retry behavior.

Files:
Gateway cancellation path in `gateway/server.js`, worker runtime code when
introduced, and smoke tests.

Boundary:
Cancellation is a stored request. The gateway does not send process signals,
SSH, or shell commands to the execution machine. The worker stops local
processes using local authority and reports `canceled`.

Acceptance:
Canceling a queued run marks it canceled; canceling a claimed/running run is
returned in heartbeat/WS; the worker reports `canceled`; a missed heartbeat
expires the claim; runs requeue only while attempts remain and the run was not
canceled.

Verification:
Smoke covers queued cancel, running cancel, stale result after cancel, lease
expiry requeue, and max-attempt failure.

Deploy target or blocker:
Gateway and worker preview only after verification. Active promotion blocked by
human gate.

### 6. Worker Runtime Pull Loop

Lane:
Execution machine

Outcome:
Build the local worker loop that registers, polls or opens WebSocket outbound,
claims scoped runs, executes local harness profiles, and reports events/results.

Files:
Worker runtime path selected by the implementation owner, local harness profile
config, and smoke scripts. Do not edit Android/browser clients for this ticket.

Boundary:
The worker starts no listener. It maps gateway `harness` and project aliases to
local allowlisted commands and paths. The gateway cannot supply arbitrary
commands, env, or shell text.

Acceptance:
The worker can run the deterministic `echo` harness from an outbound-only
connection and can reject a claim whose harness or project alias is not locally
allowed.

Verification:
Local smoke proves registration, outbound claim, heartbeat, event append,
result reporting, and local rejection of disallowed harness/project data.

Deploy target or blocker:
Worker preview only. No active gateway promotion without human approval.

### 7. First Worker Smoke

Lane:
Verification/deploy

Outcome:
Create the first end-to-end smoke test for the worker-pull loop.

Files:
Gateway smoke script location chosen by implementation owner, worker smoke
script location chosen by implementation owner, and any test fixtures.

Boundary:
Smoke runs against an isolated preview gateway or local test gateway. It must
not restart, deploy, or mutate the active app.

Acceptance:

- Queue an `echo` run linked to session, branch, route decision, context pack,
  work node, artifacts, and deployment refs.
- Register a worker with a one-use setup code.
- Verify the worker process starts no listener and connects outbound only.
- Claim exactly one run through long-poll or WebSocket.
- Verify the claim payload contains no `command`, `shell`, `env`, raw
  credential, or active deployment apply instruction.
- Send heartbeat, one stdout event, and terminal `completed` result.
- Read the run back and observe `queued`, `claimed`, `started`, `stdout`, and
  `completed` events plus the linkage fields.
- Verify a stale second result cannot overwrite the terminal result.
- Record that no active deployment was applied.

Verification:
`cd gateway && npm run check`, then the new worker smoke command once added.
For this docs-only lane, run
`fabro validate .fabro/workflows/vps-agent-control-plane/workflow.fabro`.

Deploy target or blocker:
No deploy for docs-only work. Future code smoke runs against preview only;
active promotion blocked by human gate.

## Open Implementation Decisions

- Whether the first worker runtime lives inside `gateway/` as a script or as a
  separate package.
- Whether WebSocket support lands in the first code slice or waits until
  long-poll is proven.
- Whether worker tokens are long-lived with rotation or short-lived with
  refresh in the first hosted preview.
- The exact Postgres schema for worker credentials and run leases once agent-run
  storage moves out of JSON files.

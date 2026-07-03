# Voice Work-History Control Plane

## Context

The remote gateway makes Chief Moa reachable from phone, browser, and execution
machine clients, but it must not become an executor. Voice can create durable
intent, route work, query history, and request local UI handoff. Harnesses,
browser actions, phone actions, active deployment promotion, and local UI opens
remain owned by the worker or client that claims the request and posts a
receipt.

This contract extends the remote-hosted gateway, event substrate, work graph,
artifact store, and message broker changes. It assumes:

- every spoken or typed message is first stored as a `broker_event`;
- user-visible state is represented as append-only `product_event` records plus
  rebuildable projections;
- work output is stored as durable artifacts, not chat-only memory;
- execution machines claim queued runs over an outbound worker channel;
- Android and browser clients claim local tool requests before doing anything
  on the device or page;
- deployment URLs are records, and active promotion is explicit.

## Goals

- Let voice create tasks and agent runs without blocking the phone or browser.
- Let voice ask "what is running", "what changed", "what failed", "what link do
  I use", and receive answers from durable work history.
- Let voice attach feedback to active tasks, runs, verification failures, or
  deployment records without implicitly canceling or overwriting work.
- Let voice ask a client to open the relevant UI while preserving client-local
  authority.
- Define the before/after codebase evidence model for agent work.
- Define acceptance criteria and smoke checks for the first implementation.

## Non-Goals

- No hidden shell, browser, Android, or deployment execution from a voice turn.
- No provider conversation memory as the source of truth.
- No active URL change, service restart, or Master Orch apply action without an
  explicit current-turn user promotion request.
- No requirement that every status question starts a model run.

## Control-Plane Flow

```text
voice/text input
  -> gateway stores voice_turn/chat_turn and broker_event
  -> broker emits durable route_decision records
  -> gateway creates or queries control-plane records
  -> target worker/client may claim a proposal
  -> target posts lifecycle events, artifacts, and receipts
  -> status/deployment/UI projections answer later voice queries
```

The gateway may enqueue proposals and answer from projections. It does not
execute the proposed action.

## Spoken Operations

### Create A Task Or Run

Examples:

- "Have the VPS agent build the control-plane contract."
- "Start a run to fix the gateway check failure."
- "Fork a second agent to review the browser extension."

Required behavior:

- Store the original `voice_turn` or `chat_turn` and one canonical
  `broker_event`.
- Create a `route_decision` with the selected project, workflow/package, target
  lane, confidence, reason, context refs, and cancellation policy.
- Create a `work_task` when the user describes an outcome that may need one or
  more runs.
- Create an `agent_run` only as `queued` or `proposed` until an execution worker
  claims it.
- Link the task/run to the broker event, session, branch, user id, profile
  version, and context pack ref.
- Return a short spoken/display answer with the task id, run id if created, and
  initial status.

The execution machine records `run.claimed` before it reads a repo or starts a
harness. If no worker claims the run, it remains queued and visible.

### Check Status

Examples:

- "What is still running?"
- "What did VPS-05 change?"
- "Show me the last verification failure."
- "Which runs are waiting on me?"

Required behavior:

- Answer from projections over `product_event`, work graph events, artifacts,
  and deployment records.
- Include ids and states for active tasks/runs, plus the latest meaningful
  event time.
- Include blocking reasons when known: unclaimed worker, failed verification,
  pending user approval, missing deployment link, or rejected client request.
- Do not ask a worker to do new work unless the user asks for a new action.
- If the answer depends on fresh local state, enqueue a proposal for the owning
  worker/client to report status, then say that a status refresh was requested.

### Attach Feedback

Examples:

- "Tell the active gateway run to keep the old token path."
- "That result is wrong; attach this feedback to VPS-05."
- "Cancel the browser run after it saves its current evidence."

Required behavior:

- Store `user_feedback` as its own event with source transcript, target refs,
  intent class, and urgency.
- Route feedback to one or more active tasks/runs without canceling them unless
  the user explicitly requested cancellation or pause.
- For cancellation, create a `run_control_request` proposal. The owning worker
  must claim it, checkpoint or reject it, and receipt the final state.
- Preserve feedback order by causation/correlation ids so a worker can rebuild
  the conversation around a run.
- Surface whether feedback was attached, queued for claim, rejected, or applied.

### Ask For Deployment Links

Examples:

- "What is the latest preview link?"
- "Give me the active gateway URL for that run."
- "Create a deploy request for this branch, but do not apply it."

Required behavior:

- Query `deployment_record` projections first. Return the latest relevant
  preview URL, active URL, artifact URL, build id, commit sha, and smoke status
  when present.
- Distinguish `preview`, `applied`, `failed`, and `superseded` records.
- If the user asks for a new deploy or missing link, create a
  `deployment_request` proposal for the owning deploy worker/control plane.
- Do not apply a deployment, switch the active URL, call Master Orch apply, or
  restart an active service unless the user explicitly asks to promote/apply in
  the current turn.
- Active promotion records must link to a read-only backup record, restore check
  artifact, applied deployment id, and post-apply smoke artifact.

### Ask A Client To Open The Relevant UI

Examples:

- "Open the run page on my phone."
- "Have Chrome open the diff for VPS-05."
- "Bring up the deployment preview."

Required behavior:

- Resolve a safe deep link or route target from durable records:
  `task`, `run`, `diff`, `verification`, `deployment`, or `feedback`.
- Create a `tool_request` addressed to a specific `device_client` or to the
  best available client class.
- The target client must claim the request, validate that it can open the route,
  perform the local UI action, and post a receipt.
- If no client is online, the request remains pending and the gateway returns
  the link as text.
- The gateway never opens browser tabs, Android activities, or desktop windows
  by itself.

## Durable Evidence Model

All evidence records are product events with stable ids, idempotency keys,
causation/correlation ids, user attribution, and blob/artifact refs. Projections
may denormalize them for fast status views, but the events remain canonical.

### Work Task

`work_task` is the user-facing durable unit of intent.

Required fields:

- `task_id`
- `title`
- `objective`
- `status`: `proposed | queued | active | blocked | completed | canceled`
- `session_id`, `branch_id`, `project_id`, optional `subproject_id`
- `created_from_broker_event_id`
- `owner_hint`: workflow, lane, or target worker class
- `linked_run_ids`
- `acceptance_refs`
- `latest_status_event_id`

### Repo Snapshot Ref

`repo_snapshot_ref` captures the codebase state before and after worker-owned
changes.

Required fields:

- `snapshot_id`
- `role`: `before | after | checkpoint`
- `repo_id`, `repo_path_hint`, `remote_url_hash`
- `branch`
- `commit_sha`
- `head_ref`
- `worktree_id`
- `dirty_state`: `clean | dirty | unknown`
- `tracked_change_summary`
- `submodule_refs`
- `created_by_worker_id`
- `created_at`
- `artifact_ref` for machine-readable details when available

The before snapshot is recorded after a worker claims a run and before it edits
files. The after snapshot is recorded after edits and verification, before the
worker marks the run complete. Dirty state must not print secrets or `.env`
contents.

### Diff Ref

`diff_ref` links the before and after snapshots.

Required fields:

- `diff_id`
- `base_snapshot_id`
- `head_snapshot_id`
- `patch_artifact_ref`
- `changed_paths`
- `stats`: files, insertions, deletions
- `patch_id` or content hash
- `redaction_status`
- `created_by_worker_id`

Diff artifacts may be stored as generated patches or compare URLs. They must
preserve enough information for a later reviewer to inspect what changed without
depending on chat history.

### Run Event

`run_event` records lifecycle and control transitions.

Required event types:

- `run.proposed`
- `run.queued`
- `run.claimed`
- `run.started`
- `run.context_pack_created`
- `run.feedback_attached`
- `run.control_requested`
- `run.checkpointed`
- `run.output_proposed`
- `run.verification_started`
- `run.verification_completed`
- `run.deployment_requested`
- `run.completed`
- `run.failed`
- `run.canceled`

Each run event links to the `run_id`, optional `task_id`, actor, worker id when
claimed, and relevant artifact refs.

### Verification Artifact

`verification_artifact` records commands, smoke checks, and manual QA evidence.

Required fields:

- `verification_id`
- `run_id`, optional `task_id`
- `surface`: `gateway | android | browser_extension | workflow_docs | deploy`
- `command` or manual check name
- `started_at`, `finished_at`
- `exit_code`
- `status`: `passed | failed | skipped | blocked`
- `summary`
- `stdout_ref`, `stderr_ref`, optional screenshot/log refs
- `snapshot_id` or `diff_id`
- `environment_ref`

The summary is safe to speak. Raw logs live behind artifact refs and can be
redacted.

### Deployment Record

`deployment_record` captures preview, artifact, and active deployment state.

Required fields:

- `deployment_id`
- `request_id`
- `target`: `gateway | android | browser_extension | website | all | other`
- `mode`: `preview | applied | artifact_only`
- `status`: `requested | building | available | applied | failed | superseded`
- `commit_sha`
- `artifact_refs`
- `preview_url`
- `active_url`
- `deployment_control_plane`: `master_orch | script | manual | external`
- `backup_record_ref`
- `restore_check_ref`
- `smoke_artifact_ref`
- `applied_by_actor`
- `applied_at`

Preview availability is not active promotion. An `applied` record requires the
explicit promotion request and linked backup/restore/smoke evidence when an
active service or URL changes.

### User Feedback

`user_feedback` preserves follow-up intent as durable evidence.

Required fields:

- `feedback_id`
- `source_turn_id`
- `source_broker_event_id`
- `target_refs`: tasks, runs, deployment records, verification artifacts
- `intent`: `note | correction | requirement | cancellation | approval |
  rejection | question`
- `transcript`
- `summary`
- `routing_decision_ids`
- `status`: `attached | queued_for_claim | applied | rejected`

Feedback is evidence until a worker/client claims a linked proposal and receipts
how it handled the feedback.

### UI Open Request And Receipt

UI opening uses the existing `tool_request` and `receipt` boundary.

Required request fields:

- `request_id`
- `target_client_id` or `target_surface`
- `tool`: `ui.open`
- `route_kind`
- `route_ref`
- `safe_url`
- `created_from_turn_id`
- `status`: `queued | claimed | completed | rejected | expired`

Required receipt fields:

- `receipt_id`
- `request_id`
- `client_id`
- `decision`: `opened | rejected | expired`
- `reason`
- `opened_route`
- `created_at`

## Proposal, Claim, Receipt Policy

Every mutating operation moves through this policy:

```text
proposal stored
  -> target may claim
  -> target validates local authority and current state
  -> target executes or rejects
  -> target posts receipt/event
  -> projection updates status
```

The policy applies to harness runs, deploy requests, client UI opens,
browser/CDP actions, Android actions, cancellation, and active promotion.
Repeated voice turns use idempotency keys derived from the turn id plus target
operation so retries do not duplicate work.

## Acceptance Criteria

- A voice request to create work stores a turn, broker event, route decision,
  task, and queued run without starting harness execution until a worker claims
  it.
- A claimed worker run records a before snapshot before edits, an after snapshot
  after edits, a diff ref, run lifecycle events, verification artifacts, and a
  completion or failure event.
- A status question answers from durable projections and names active, blocked,
  completed, and waiting-on-user work without launching new work.
- A feedback utterance attaches to the relevant task/run as `user_feedback` and
  is non-interrupting unless the user explicitly requests pause/cancel.
- A deployment-link question returns existing preview/active/artifact records or
  creates a deployment request proposal; it never promotes or restarts the
  active service by implication.
- A UI-open request creates a client-addressed `tool_request`; only the claimed
  client can open the UI and receipt the result.
- All records needed to answer "what happened before and after this run" can be
  reconstructed from product events and artifact refs after projection rebuild.

## Smoke Checks

- Voice create smoke: send a deterministic voice/text turn for "create a task
  and run"; assert one broker event, one route decision, one task, and one
  queued run exist, with no claimed/executed event.
- Worker evidence smoke: simulate a worker claim and completion; assert before
  snapshot, after snapshot, diff ref, verification artifact, and run completion
  are linked and queryable by run id.
- Status smoke: query active work; assert the answer is built from projections
  and includes queued, active, blocked, and completed examples.
- Feedback smoke: attach a spoken correction to an active run; assert the run
  gains `run.feedback_attached` and no cancellation event appears unless
  cancellation was explicit.
- Deployment-link smoke: query latest preview and active links; assert preview
  and applied records are distinct and no apply/promotion event is created.
- UI-open smoke: request opening a run page on a client; assert a queued
  `ui.open` tool request, a client claim, and a receipt, with the gateway doing
  no local UI action.

# Worker Pull Execution Contract

## Scope

This contract defines how a remote VPS gateway queues agent runs while a user's
execution machine claims and executes those runs by connecting outbound to the
gateway. It covers worker credentials, registration, claim transport,
heartbeat, event streaming, result reporting, cancellation, retry behavior, and
the run links needed for sessions, branches, artifacts, and deployments.

The contract is intentionally bounded:

- The execution machine opens no inbound port.
- The VPS gateway never SSHes into the execution machine.
- The VPS gateway never receives an unrestricted shell, command string, raw
  environment, or harness credential for the execution machine.
- The gateway queues and records work. The worker validates, executes, and
  receipts work inside the local execution boundary.
- Harness output remains a proposal. Deployment promotion remains a human gate
  unless a later turn explicitly approves promotion.

## Authorities

| Surface | Authority |
| --- | --- |
| Gateway | Authenticates users/devices/workers, stores queued runs, leases claims, records events/results, links runs to sessions, branches, work artifacts, and deployment candidates. |
| Worker | Connects outbound, advertises local harness capabilities, claims one scoped run, resolves local repo/project paths from an allowlist, runs the named harness locally, streams events, and reports a terminal result. |
| Android/browser clients | Start or inspect work through normal gateway auth. They do not hold provider keys or worker tokens. |
| Human promotion gate | Applies active deployments and active URL changes after backup/restore checks. |

## Credential Model

Worker tokens are distinct from device tokens and user session cookies.

Worker token claims:

```json
{
  "token_id": "wkt_01HX...",
  "worker_id": "wrk_01HX...",
  "user_id": "usr_01HX...",
  "scopes": [
    "agent_runs:claim",
    "agent_runs:read_claim",
    "agent_runs:heartbeat",
    "agent_runs:append_event",
    "agent_runs:complete",
    "agent_runs:observe_cancel"
  ],
  "harness_allowlist": ["codex", "claude", "gemini", "echo"],
  "project_allowlist": ["proj_chief_moa"],
  "max_parallel_claims": 1,
  "expires_at": "2026-08-02T00:00:00.000Z",
  "revoked_at": null
}
```

Worker tokens must not authorize:

- Creating agent runs.
- Reading unrelated sessions, voice turns, device records, browser tasks, or
  account settings.
- Calling gateway provider/model APIs directly.
- Registering devices.
- Deploying, applying, or switching active deployment URLs.
- Sending raw shell commands from the gateway to the worker.

The gateway stores only a token hash. The plaintext token is returned once at
registration or rotation.

## Worker Registration

Registration is an owner-approved bootstrap flow. The owner creates a short
lived registration code from an authenticated gateway UI/session. The execution
machine uses that code once to receive a worker token.

### Create Registration

`POST /v1/agent/workers/registrations`

Auth: better-auth owner session or legacy owner gateway token during the
migration window.

Request:

```json
{
  "name": "Nat Mac Studio",
  "harness_allowlist": ["codex", "claude", "gemini", "echo"],
  "project_allowlist": ["proj_chief_moa"],
  "max_parallel_claims": 1,
  "expires_in_seconds": 600
}
```

Response `201`:

```json
{
  "registration_id": "wreg_01HX...",
  "setup_code": "MOA-WORKER-8KJ4-PQ2M",
  "expires_at": "2026-07-03T09:28:50.000Z",
  "register_url": "https://api.example.com/v1/agent/workers/register",
  "constraints": {
    "max_parallel_claims": 1,
    "harness_allowlist": ["codex", "claude", "gemini", "echo"],
    "project_allowlist": ["proj_chief_moa"]
  }
}
```

### Register Worker

`POST /v1/agent/workers/register`

Auth: one-use `setup_code`.

Request:

```json
{
  "registration_id": "wreg_01HX...",
  "setup_code": "MOA-WORKER-8KJ4-PQ2M",
  "worker": {
    "name": "Nat Mac Studio",
    "version": "moa-worker/0.1.0",
    "machine_label": "macstudio-local",
    "capabilities": {
      "transports": ["long_poll", "websocket"],
      "harnesses": [
        {
          "id": "codex",
          "version": "codex-cli",
          "supports_resume": true
        },
        {
          "id": "echo",
          "version": "builtin",
          "supports_resume": false
        }
      ],
      "projects": [
        {
          "id": "proj_chief_moa",
          "local_alias": "chief-moa",
          "path_policy": "local_allowlist"
        }
      ]
    }
  }
}
```

Response `201`:

```json
{
  "worker_id": "wrk_01HX...",
  "worker_token": "moa_wkt_plaintext_returned_once",
  "token_id": "wkt_01HX...",
  "expires_at": "2026-08-02T00:00:00.000Z",
  "claim_url": "/v1/agent/workers/claim",
  "websocket_url": "/v1/agent/workers/ws",
  "heartbeat_interval_ms": 15000,
  "lease_duration_ms": 60000
}
```

Repeated use of the same registration code returns `409 registration_used`.
Expired codes return `410 registration_expired`.

## Run Linkage

Every queued run must carry enough linkage to make it inspectable and
resumeable without provider memory.

Required run linkage:

```json
{
  "run_id": "run_01HX...",
  "session": {
    "session_id": "sess_01HX...",
    "conversation_id": "sess_01HX...",
    "branch_id": "default",
    "turn_id": "turn_01HX...",
    "broker_event_id": "bev_01HX...",
    "route_decision_id": "route_01HX..."
  },
  "work": {
    "work_node_id": "wg_01HX...",
    "context_pack_ref": "broker-context-packs/pack_01HX.json",
    "parent_run_id": "",
    "project_id": "proj_chief_moa",
    "profile_version": "prof_01HX..."
  },
  "artifacts": {
    "input_refs": [
      {
        "artifact_id": "art_01HX...",
        "kind": "context_pack",
        "uri": "broker-context-packs/pack_01HX.json",
        "sha256": "012345..."
      }
    ],
    "output_refs": []
  },
  "deployments": {
    "candidate_refs": [],
    "apply_allowed": false,
    "promotion_gate": "human"
  }
}
```

Compatibility note: the current file-backed run store already has
`conversation_id`, `parent_run_id`, `project_id`, `profile_version`,
`resume_session_id`, `working_dir`, and append-only run events. Until
`session_id` and `branch_id` are first-class fields, `conversation_id` is the
stable session id and `branch_id` defaults to `default`.

Deployment candidates are links only. A worker may produce a preview artifact or
candidate deployment record, but the gateway must not apply it to the active URL
from worker result data.

## Claim Transport

Long-poll is the first transport. A WebSocket may use the same envelope once the
long-poll contract is implemented.

### Long-poll Claim

`POST /v1/agent/workers/claim`

Auth: worker token with `agent_runs:claim`.

Request:

```json
{
  "worker_id": "wrk_01HX...",
  "transport": "long_poll",
  "wait_ms": 25000,
  "max_claims": 1,
  "accepted_harnesses": ["codex", "echo"],
  "accepted_projects": ["proj_chief_moa"],
  "last_seen_event_id": "evt_01HW..."
}
```

No available work response `200`:

```json
{
  "claimed": false,
  "retry_after_ms": 1000,
  "server_time": "2026-07-03T09:20:00.000Z"
}
```

Claim response `200`:

```json
{
  "claimed": true,
  "claim": {
    "claim_id": "clm_01HX...",
    "run_id": "run_01HX...",
    "worker_id": "wrk_01HX...",
    "attempt": 1,
    "lease_expires_at": "2026-07-03T09:21:00.000Z",
    "heartbeat_interval_ms": 15000,
    "event_url": "/v1/agent/runs/run_01HX/events",
    "heartbeat_url": "/v1/agent/runs/run_01HX/heartbeat",
    "result_url": "/v1/agent/runs/run_01HX/result"
  },
  "run": {
    "id": "run_01HX...",
    "status": "claimed",
    "harness": "codex",
    "prompt": "Implement the scoped task...",
    "source": "broker",
    "timeout_ms": 1800000,
    "resume_session_id": "",
    "working_dir": {
      "project_id": "proj_chief_moa",
      "local_alias": "chief-moa"
    },
    "session": {
      "session_id": "sess_01HX...",
      "conversation_id": "sess_01HX...",
      "branch_id": "default",
      "turn_id": "turn_01HX...",
      "broker_event_id": "bev_01HX...",
      "route_decision_id": "route_01HX..."
    },
    "work": {
      "work_node_id": "wg_01HX...",
      "context_pack_ref": "broker-context-packs/pack_01HX.json",
      "parent_run_id": "",
      "profile_version": "prof_01HX..."
    },
    "artifacts": {
      "input_refs": [],
      "output_refs": []
    },
    "deployments": {
      "candidate_refs": [],
      "apply_allowed": false,
      "promotion_gate": "human"
    }
  }
}
```

The gateway must not include `command`, `args`, `shell`, `env`, or arbitrary
absolute paths in the claim payload. The worker maps `harness` and
`working_dir.local_alias` to local allowlisted profiles and paths.

### WebSocket Envelope

`GET /v1/agent/workers/ws`

Auth: worker token.

All WebSocket messages use:

```json
{
  "type": "worker.ready",
  "id": "msg_01HX...",
  "ts": "2026-07-03T09:20:00.000Z",
  "worker_id": "wrk_01HX...",
  "payload": {}
}
```

Gateway to worker offer:

```json
{
  "type": "run.claim_offered",
  "id": "msg_01HX...",
  "ts": "2026-07-03T09:20:01.000Z",
  "worker_id": "wrk_01HX...",
  "payload": {
    "claim": {
      "claim_id": "clm_01HX...",
      "run_id": "run_01HX...",
      "lease_expires_at": "2026-07-03T09:21:01.000Z"
    },
    "run": {
      "id": "run_01HX...",
      "harness": "echo",
      "prompt": "smoke worker pull"
    }
  }
}
```

Worker response:

```json
{
  "type": "run.claim_accepted",
  "id": "msg_01HY...",
  "ts": "2026-07-03T09:20:02.000Z",
  "worker_id": "wrk_01HX...",
  "payload": {
    "claim_id": "clm_01HX...",
    "run_id": "run_01HX..."
  }
}
```

The gateway finalizes the lease only after acceptance. If the worker does not
accept before the offer deadline, the run stays claimable.

## Heartbeat

`POST /v1/agent/runs/{run_id}/heartbeat`

Auth: current worker token for the current claim.

Request:

```json
{
  "worker_id": "wrk_01HX...",
  "claim_id": "clm_01HX...",
  "status": "running",
  "progress": {
    "phase": "tests",
    "message": "running gateway smoke",
    "percent": null
  },
  "last_event_seq": 12,
  "observed_at": "2026-07-03T09:24:00.000Z"
}
```

Response `200`:

```json
{
  "ok": true,
  "run_id": "run_01HX...",
  "claim_id": "clm_01HX...",
  "lease_expires_at": "2026-07-03T09:25:00.000Z",
  "cancel_requested": false,
  "server_time": "2026-07-03T09:24:00.500Z"
}
```

If `cancel_requested` is true, the worker must stop the local harness using its
local process controls and then report a terminal `canceled` result. The gateway
does not send a shell command or process signal to the worker.

## Event Streaming

`POST /v1/agent/runs/{run_id}/events`

Auth: current worker token for the current claim.

Request:

```json
{
  "worker_id": "wrk_01HX...",
  "claim_id": "clm_01HX...",
  "events": [
    {
      "seq": 1,
      "event_id": "wevt_01HX...",
      "type": "started",
      "observed_at": "2026-07-03T09:20:03.000Z",
      "data": {
        "harness": "echo",
        "local_project_alias": "chief-moa"
      }
    },
    {
      "seq": 2,
      "event_id": "wevt_01HY...",
      "type": "stdout",
      "observed_at": "2026-07-03T09:20:04.000Z",
      "data": {
        "text": "worker smoke complete\n"
      }
    },
    {
      "seq": 3,
      "event_id": "wevt_01HZ...",
      "type": "artifact_produced",
      "observed_at": "2026-07-03T09:20:05.000Z",
      "data": {
        "artifact_id": "art_01HX...",
        "kind": "log_tail",
        "uri": "agent-runs/run_01HX/log-tail.txt",
        "sha256": "abcdef..."
      }
    }
  ]
}
```

Response `200`:

```json
{
  "ok": true,
  "accepted": 3,
  "duplicate": 0,
  "last_event_seq": 3,
  "cancel_requested": false
}
```

Event rules:

- `event_id` is idempotent per run. Duplicate events return success with a
  duplicate count and are not appended twice.
- Text chunks are bounded. The gateway truncates stored chunks; the worker
  should redact secrets before sending logs.
- Gateway storage appends events to the existing agent-run event log and mirrors
  them to the product event substrate.
- `artifact_produced` links artifacts to the run but does not apply or publish
  them.

## Result Reporting

`POST /v1/agent/runs/{run_id}/result`

Auth: current worker token for the current claim.

Request:

```json
{
  "worker_id": "wrk_01HX...",
  "claim_id": "clm_01HX...",
  "status": "completed",
  "finished_at": "2026-07-03T09:25:00.000Z",
  "exit_code": 0,
  "signal": null,
  "error": "",
  "output": "Worker smoke complete.",
  "stdout_tail": "Worker smoke complete.\n",
  "stderr_tail": "",
  "session_id": "codex_resume_01HX...",
  "retryable": false,
  "artifacts": [
    {
      "artifact_id": "art_01HX...",
      "kind": "work_summary",
      "uri": "agent-runs/run_01HX/summary.md",
      "sha256": "fedcba..."
    }
  ],
  "deployments": [
    {
      "candidate_id": "dep_01HX...",
      "target": "gateway-preview",
      "preview_url": "https://preview.example.com",
      "applied": false,
      "apply_allowed": false
    }
  ]
}
```

Response `200`:

```json
{
  "ok": true,
  "run": {
    "id": "run_01HX...",
    "status": "completed",
    "worker_id": "wrk_01HX...",
    "claim_id": "clm_01HX...",
    "finished_at": "2026-07-03T09:25:00.000Z",
    "artifact_refs": ["art_01HX..."],
    "deployment_refs": ["dep_01HX..."]
  }
}
```

Terminal statuses are `completed`, `failed`, `timed-out`, and `canceled`.
Results from a stale claim return `409 stale_claim` and must not overwrite a
newer claim or terminal result.

## Cancellation

Users and authorized gateway clients keep using:

`POST /v1/agent/runs/{run_id}/cancel`

Gateway behavior:

- `queued`: mark `canceled`, append `cancel_requested` and `canceled`.
- `claimed` or `running`: append `cancel_requested`, keep the lease, and return
  cancellation in heartbeat/WS responses.
- terminal: return the existing terminal run without mutation.

Worker behavior:

- Observe cancellation through heartbeat or WebSocket.
- Stop the local harness using worker-owned process controls.
- Emit `cancellation_observed`.
- Report terminal result `canceled`.

The gateway never sends `kill`, shell text, SSH, or a platform process command
to the worker.

## Retry And Lease Behavior

Run state additions:

```json
{
  "status": "claimed",
  "attempt": 1,
  "max_attempts": 2,
  "claimed_by_worker_id": "wrk_01HX...",
  "claim_id": "clm_01HX...",
  "lease_expires_at": "2026-07-03T09:25:00.000Z",
  "last_heartbeat_at": "2026-07-03T09:24:00.000Z",
  "retry_after_at": null,
  "retry_reason": ""
}
```

Retry rules:

- If a worker disconnects before a result and the lease expires, the gateway
  appends `claim_expired`.
- If `attempt < max_attempts` and the run is not canceled, the gateway requeues
  the run with `retry_after_at` and a new claim can be issued.
- If `attempt >= max_attempts`, the gateway marks the run `failed` with
  `error: "worker claim expired"`.
- A worker-reported `failed` result with `retryable: true` may be requeued if
  attempts remain. `retryable: false` is terminal.
- `timed-out` is terminal for the attempt. Automatic retry requires
  `retryable: true` and attempts remaining.
- Duplicate claim/result/event requests are idempotent when they use the same
  `claim_id` or `event_id`; conflicting stale writes fail.

## Failure Modes

All worker endpoints return a bounded error envelope:

```json
{
  "error": {
    "code": "stale_claim",
    "message": "claim is no longer current for this run",
    "retryable": false
  },
  "request_id": "req_01HX..."
}
```

| Status | Code | Meaning | Expected worker behavior |
| --- | --- | --- | --- |
| 400 | `invalid_request` | JSON shape or required field is invalid. | Stop or fix client request. |
| 401 | `invalid_worker_token` | Missing, expired, or malformed worker token. | Stop claiming and require re-registration or rotation. |
| 403 | `insufficient_scope` | Token lacks required scope, project, or harness permission. | Do not retry this run without a new token. |
| 404 | `run_not_found` | Run id does not exist or is outside token scope. | Stop reporting that run. |
| 409 | `already_claimed` | Another worker holds the current lease. | Back off and claim another run. |
| 409 | `stale_claim` | Claim id no longer owns the run. | Stop local work if still running; do not report terminal overwrite. |
| 410 | `registration_expired` | Registration code expired. | Ask owner for a new setup code. |
| 413 | `event_too_large` | Event batch or text chunk exceeds limits. | Send smaller chunks. |
| 422 | `harness_not_allowed` | Run requires a harness the worker cannot claim. | Do not claim; update worker manifest or route elsewhere. |
| 423 | `run_cancel_requested` | The run is canceled while claim/report is in progress. | Stop local harness and report `canceled`. |
| 429 | `claim_rate_limited` | Worker is polling too fast or exceeds parallel claims. | Honor `retry_after_ms`. |
| 503 | `queue_unavailable` | Run store or event store is unavailable. | Retry with backoff; keep local process bounded. |

## First Smoke Test Acceptance Criteria

The first implementation smoke should prove the smallest end-to-end pull loop:

1. A preview gateway queues an `echo` harness run linked to a session id,
   branch id, route decision id, context pack ref, and empty deployment refs.
2. A worker registers with a one-use setup code and receives a worker token
   scoped to `agent_runs:claim`, `agent_runs:heartbeat`,
   `agent_runs:append_event`, and `agent_runs:complete`.
3. The worker starts no listener and connects outbound over HTTP or WebSocket.
4. The worker long-polls `POST /v1/agent/workers/claim`, receives exactly one
   queued run, and the gateway records the run as claimed by that worker.
5. The claim payload contains `harness`, `prompt`, `session`, `work`,
   `artifacts`, and `deployments`, and does not contain `command`, `shell`,
   `env`, or raw credentials.
6. The worker sends one heartbeat, one `stdout` event, and a terminal
   `completed` result.
7. `GET /v1/agent/runs/{run_id}` shows `queued`, `claimed`, `started`,
   `stdout`, and `completed` events, plus the session/branch/work artifact
   linkage.
8. A second claim attempt for the completed run returns no work or a stale claim
   error and cannot overwrite the terminal result.
9. The smoke report records that no active deployment was applied.

# First Self-Host User Journey

## Purpose

This journey describes the first usable path for a builder who wants a VPS
control plane, browser/mobile control surfaces, connected accounts, one bounded
worker, a preview/deployment link, mobile review, and voice feedback.

The journey is written as implementation behavior. Each step names the state
that must exist before the next step can work.

## Actors And Surfaces

- Owner: authenticated user who controls the gateway and approves devices,
  accounts, workers, and promotion.
- VPS gateway: remote Node gateway with Postgres and persistent `DATA_DIR`.
- Android client: mobile voice/text control surface and local notification/UI
  authority.
- Browser extension: browser voice/text control surface and browser-local UI
  authority.
- Account provider: OpenAI, Anthropic, Gemini, GitHub, or another user-owned
  account/integration.
- Worker: execution machine that connects outbound, claims scoped runs, edits
  repos locally, verifies, and reports results.
- Deployment control plane: script, Master Orch, or external deploy target that
  can create preview/artifact records and apply promotion when the
  active-promotion gate passes.

## Preconditions

- The user has provider subscriptions or accounts they are allowed to use.
- The user has a VPS or chooses hosted convenience to provision one.
- The gateway has a stable HTTPS origin planned, for example
  `https://api.<your-domain>`.
- The execution machine already has local repos, harness CLIs, and local
  credentials. The VPS does not receive those credentials.
- No active app, active URL, or active service is mutated during preview setup.
  Active promotion waits for preview smoke, rollback, no-interruption,
  state-compatibility, and backup/restore evidence.

## Journey Summary

```text
deploy VPS gateway
  -> create owner session
  -> connect Android and browser to the stable URL
  -> connect user-owned provider accounts
  -> register one bounded worker
  -> launch a task from mobile or browser
  -> worker claims, edits, verifies, and creates a preview/deployment record
  -> user opens the link from mobile
  -> user gives voice feedback
  -> feedback attaches to the task/run for the worker to handle
```

## Step 1: Deploy VPS Gateway

User action:

- Provision a VPS or request hosted convenience.
- Configure DNS/TLS for one stable HTTPS gateway origin.
- Provide gateway env through the VPS env file, including `MOA_MODE=self-host`
  or `MOA_MODE=hosted`, auth config, `DATABASE_URL` or Compose Postgres
  password, and `DATA_DIR` volume mapping.
- Start the gateway as a preview candidate.

System behavior:

- Gateway binds for remote access only in remote modes.
- Remote modes require auth and Postgres.
- `DATA_DIR` maps to persistent storage.
- `/health` returns process/runtime health but does not imply token success.

State created:

- stable gateway origin;
- Postgres database;
- persistent `DATA_DIR`;
- gateway runtime status.

Implementation acceptance:

- remote mode refuses to start without Postgres;
- remote mode refuses unsafe unauthenticated startup;
- container rebuild does not delete `DATA_DIR` or Postgres state;
- active user URL is not changed by this step.

## Step 2: Create Owner Session

User action:

- Sign in through the gateway UI when better-auth is enabled.
- During migration, use the legacy owner token only as a bootstrap path.

System behavior:

- Gateway creates or resolves one owner user.
- Existing single-token writes map to the seeded owner user during migration.
- Gateway UI uses a user session; devices and workers use separate tokens.

State created:

- `user` record;
- owner session;
- migration mapping from legacy token to owner user when needed.

Implementation acceptance:

- owner can reach the gateway UI;
- protected routes reject anonymous remote requests;
- user id appears on new work/account/device/worker events.

## Step 3: Connect Browser And Mobile

User action:

- Save the same stable gateway URL in Android and the browser extension.
- Start device registration from each client.
- Approve each device in the gateway UI or paste the one-time result during the
  migration path.

System behavior:

- Client stores only gateway origin plus per-device token.
- Gateway binds token to user id, device id, surface type, label, creation time,
  and revocation state.
- Client checks reachability, authentication, and voice readiness separately.

State created:

- Android `device_token`;
- browser `device_token`;
- device-client records and last-seen heartbeat state.

User-visible result:

- both clients show the same gateway origin;
- bad URL, bad token, and unavailable voice errors are distinct;
- voice ticket readiness can be tested without exposing provider keys.

Implementation acceptance:

- saving `10.147.17.10`, `10.147.17.6`, or an endpoint path shows a specific
  diagnostic;
- `/health` success followed by protected-route `401` produces a re-register
  path;
- browser and Android can each call a protected lightweight route;
- browser and Android can each report voice unavailable with a specific reason.

## Step 4: Connect Accounts

User action:

- Open account connections in the gateway UI.
- Choose a provider and credential kind: OAuth, device code, API key, PAT,
  service account, external handle, or no reusable credential.
- Complete provider-supported authorization or enter the secret into a
  gateway-served form.

System behavior:

- Gateway stores encrypted credential material or an opaque broker handle
  server-side.
- Android and browser see labels, provider ids, status, expiry, and reauth
  actions only.
- Gateway schedules refresh or sets `needs_user_action` when refresh is not
  possible.

State created:

- one or more `account_connection` records;
- secret reference records inside the gateway credential boundary;
- audit events in the product event substrate.

User-visible result:

- the user can see which accounts are connected, expired, action-required, or
  disabled;
- mobile/browser can nudge for reauth without receiving raw credentials.

Implementation acceptance:

- `GET /v1/account-connections` returns non-secret summaries;
- reauth action contains only an open URL, device code, gateway secret form, or
  provider portal instruction;
- refresh failure preserves audit history and asks for user action;
- clients never log or render raw provider credentials.

## Step 5: Register Worker

User action:

- From the gateway UI, create a short-lived worker registration for a named
  execution machine.
- Choose allowed harnesses, allowed projects, maximum parallel claims, and
  expiry.
- On the execution machine, run the worker registration command with the setup
  code.

System behavior:

- Gateway exchanges the one-use setup code for a worker token.
- Worker token is scoped to claim/read claimed run, heartbeat, append event,
  complete result, and observe cancellation.
- Worker advertises harnesses and project aliases, not arbitrary paths.

State created:

- `worker` record;
- hashed `worker_token`;
- worker capability manifest;
- last-heartbeat and online/offline state.

User-visible result:

- gateway shows the worker as registered with allowed projects and harnesses;
- the worker opens no inbound port.

Implementation acceptance:

- repeated setup-code use returns `409 registration_used`;
- expired setup code returns `410 registration_expired`;
- token cannot create runs, read unrelated sessions, register devices, or apply
  deployments;
- worker manifest resolves `project_id` to a local allowlist on the worker.

## Step 6: Launch Task

User action:

- From Android voice, browser voice, or text, ask Chief Moa to do a bounded
  task, for example: "Have the VPS worker fix the gateway check failure and
  give me a preview link."

System behavior:

- Gateway stores the voice/chat turn and one `broker_event`.
- Broker emits a `route_decision` naming project, workflow/lane, context refs,
  reason, and cancellation behavior.
- Gateway creates a `work_task`.
- Gateway creates an `agent_run` with status `queued` and `apply_allowed=false`.
- Worker long-polls or uses the worker WebSocket, claims the run, records a
  before snapshot, runs the named local harness, streams events, verifies, and
  records an after snapshot plus diff.

State created:

- `broker_event`;
- `route_decision`;
- `work_task`;
- `agent_run`;
- `repo_snapshot_ref` before and after;
- `diff_ref`;
- `verification_artifact`;
- run events and worker claim records.

User-visible result:

- client receives task id, run id, initial queued/claimed/running status, and
  latest event summary;
- phone is not blocked while the worker runs.

Implementation acceptance:

- gateway does not start a harness before a worker claim;
- claim payload includes `harness`, `prompt`, `session`, `work`, `artifacts`,
  and `deployments`;
- claim payload excludes `command`, `shell`, `env`, raw credentials, and
  untrusted absolute paths;
- status can be answered from stored events without provider memory.

## Step 7: Get Deploy Link

User action:

- Ask for the latest preview link or wait for the worker to finish with one.

System behavior:

- Worker or deployment control plane produces a deployment candidate or
  artifact link.
- Gateway stores it as a `deployment_record` with `mode=preview` or
  `mode=artifact_only`, not `applied`.
- Gateway links the deployment record to the run, task, commit, verification,
  and smoke status when available.

State created:

- `deployment_record`;
- artifact refs for logs, patch, build output, screenshots, or preview URL;
- smoke/verification refs when available.

User-visible result:

- Android and browser can show the latest preview URL, active URL if one
  already exists, commit sha, smoke status, and whether the record is applied.

Implementation acceptance:

- preview and active URLs are different fields;
- asking for a link never applies a deployment by implication;
- active promotion waits until preview smoke, rollback, no-interruption,
  state-compatibility, and backup/restore evidence exists.

## Step 8: Review From Mobile

User action:

- Ask from Android: "Open the preview for that run" or "Show me what changed."
- Review the preview link, run status, diff summary, and verification result.

System behavior:

- Gateway resolves a safe route for the task, run, diff, verification, or
  deployment record.
- Gateway queues a `tool_request` for the Android device with tool `ui.open`.
- Android claims the request, validates the route, opens the UI or link, and
  posts a receipt.
- If Android is offline, gateway returns the safe URL/text and leaves the
  request pending or expired.

State created:

- `tool_request`;
- Android `receipt`;
- optional follow-up view event.

User-visible result:

- the user can inspect the deploy link or work evidence from the phone;
- the gateway did not open a local app or browser tab by itself.

Implementation acceptance:

- UI opens require client claim plus receipt;
- offline client path returns the link as text;
- receipt records opened, rejected, expired, or failed state with a reason.

## Step 9: Give Voice Feedback

User action:

- From mobile voice, say a correction, requirement, approval, rejection, or
  cancellation. Example: "Tell that run to keep the old token path and rerun the
  gateway check."

System behavior:

- Gateway stores the new voice turn and `broker_event`.
- Broker resolves target refs to the active task/run/deployment/verification.
- Gateway appends `user_feedback` and `run.feedback_attached`.
- If work is still active, feedback is available for the owning worker to claim
  or observe.
- If a new run is needed, gateway creates a queued follow-up run linked to the
  same task.
- Cancellation happens only when the user explicitly asks to cancel or pause.

State created:

- `user_feedback`;
- route decisions for feedback routing;
- run feedback event;
- optional follow-up queued run.

User-visible result:

- client says whether feedback was attached, queued for worker, applied,
  rejected, or converted into a follow-up run;
- the user can ask status later and see the feedback in the work history.

Implementation acceptance:

- feedback preserves source transcript and target refs;
- non-cancellation feedback does not cancel active work;
- worker can reconstruct feedback order through causation/correlation ids;
- status answers mention pending user feedback when it has not been handled.

## End State Of The First Journey

The first journey is complete when all of these are true:

- a self-host or hosted VPS gateway is reachable at one stable HTTPS origin;
- Android and browser are registered against that origin with device tokens;
- at least one account connection exists with non-secret status and health;
- at least one worker is registered and can claim outbound;
- a user task produces a queued, claimed, verified, completed or failed run;
- before/after snapshots, diff ref, verification artifact, and run events are
  queryable by run id;
- a preview or artifact deployment link is stored and visible on mobile;
- mobile voice feedback attaches to the relevant task/run without hidden
  promotion or hidden local execution.

## Explicit Promotion Blocker

This journey stops at preview and feedback. Applying a deployment, switching an
active URL, restarting an active service, publishing Android OTA, or reloading a
browser extension is outside the first self-host journey unless the user
explicitly asks for promotion in the current turn.

Promotion requires:

- read-only Postgres dump from the active database;
- active `DATA_DIR` snapshot;
- restore check into scratch Postgres and scratch data volume;
- scratch gateway health/read-path smoke;
- explicit apply/promotion request;
- post-apply smoke record linked to the deployment record.

## Ticket Skeleton

Use these ticket names when converting the journey into implementation work:

| Ticket | Acceptance check |
| --- | --- |
| `vps-self-host-safe-start` | Remote mode requires Postgres/auth and persists `DATA_DIR`. |
| `owner-session-bootstrap` | Owner session or migration token maps events to one user id. |
| `device-registration-stable-url` | Android/browser register against one HTTPS origin and diagnose bad URL/token/voice separately. |
| `account-connection-status` | Provider connection list exposes non-secret health, refresh, and reauth state. |
| `worker-registration-code` | One-use code returns scoped worker token and rejects reuse/expiry. |
| `worker-claim-smoke` | Worker claims one queued run outbound and reports heartbeat, event, and result. |
| `run-evidence-artifacts` | Claimed run records before snapshot, after snapshot, diff, and verification artifact. |
| `deployment-preview-record` | Worker/deploy path stores preview or artifact link without applying it. |
| `mobile-review-open-request` | Android opens a run/deployment route only through tool request and receipt. |
| `voice-feedback-routing` | Spoken feedback attaches to target run/task and preserves non-canceling semantics. |

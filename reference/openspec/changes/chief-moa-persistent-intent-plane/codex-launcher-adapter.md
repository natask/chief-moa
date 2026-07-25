# Codex launcher adapter slice

The first local launcher adapter is
`scripts/codex-intent-launcher/cli.js`. It makes an explicitly requested,
non-interactive local process observable through `moa.intent-plane.v1`.

## Contract

1. The launcher requires explicit user confirmation and stable namespace,
   project, intent, and agent keys.
2. Hosted intent and agent registration succeeds before local execution by
   default.
3. A machine-local `adapter_run_id` connects queued/running/terminal state,
   logs, recap, and receipt to the stable hosted agent.
4. Every attempt uses the hosted run-start command. A later run for a terminal
   stable owner requires explicit reopen authority and a different run ID.
5. Completion moves the owning intent to `completed`. Failure, cancellation,
   interruption, or an unrecoverable missing process moves it to `needs_user`.
6. Terminal agent and intent transitions have separate durable checkpoints,
   stable idempotency keys, and immutable payloads. Retry resumes only the
   incomplete stage.
7. A hosted outage leaves an explicit `remote_pending` record. Offline launch
   requires `--allow-offline`; reconciliation uploads it later.
8. The selected gateway credential and known Chief Moa credentials are never
   persisted and are removed from the launched command environment.
9. The adapter automatically prepends a direct-worker contract with numeric
   child-agent maximum zero. The worker is not the user-facing root launcher.
10. Hosted URLs require HTTPS except for loopback development. Local liveness
    binds PID to operating-system start identity and treats ambiguity as blocked.

## Boundary

This slice does not import in-conversation collaboration subagents, expose
first-class direct chat, or manufacture a Codex session ID. It supervises
`codex exec` because that is the supported non-interactive local process
surface. The migration target is a hosted launch queue plus an execution
service that exposes a stable runtime/session handle, heartbeats, resume,
message, and cancellation.

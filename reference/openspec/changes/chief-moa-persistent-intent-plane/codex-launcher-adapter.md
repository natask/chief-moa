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
4. Completion moves the owning intent to `completed`. Failure, cancellation,
   interruption, or an unrecoverable missing process moves it to `needs_user`.
5. A hosted outage leaves an explicit `remote_pending` record. Offline launch
   requires `--allow-offline`; reconciliation uploads it later.
6. The gateway credential is never persisted and is removed from the launched
   command environment.
7. The adapter grants no child-agent authority. The task prompt and applicable
   `AGENTS.md` determine the direct owner's bounded role.

## Boundary

This slice does not import in-conversation collaboration subagents, expose
first-class direct chat, or manufacture a Codex session ID. It supervises
`codex exec` because that is the supported non-interactive local process
surface. The migration target is a hosted launch queue plus an execution
service that exposes a stable runtime/session handle, heartbeats, resume,
message, and cancellation.

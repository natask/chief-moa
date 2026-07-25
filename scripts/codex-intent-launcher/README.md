# Chief Moa Codex intent launcher

This adapter makes a locally launched `codex exec` process visible in Chief
Moa's hosted intent plane. It is a narrow bridge, not a replacement Codex
runtime and not a claim that Codex subagents are currently first-class,
cross-session chat identities.

## What it guarantees

- Derives stable intent and agent IDs from explicit namespace, project, intent,
  and agent keys.
- Sends additive tenant, namespace, sphere, project, runtime, parent, endpoint,
  and recovery metadata when the hosted global authority supports it.
- Requires `--user-confirmed` before admitting an intention.
- Registers launch reason, launcher provenance, capabilities, and bounded
  authority before starting by default.
- Persists queued, running, progress, and terminal state locally with `0600`
  files.
- Writes stdout, stderr, final recap, and a terminal receipt as durable artifact
  references.
- Converts completion to an intent-plane completion ping. A blocked, cancelled,
  or failed owner moves the intent to `needs_user`, which creates a durable ping.
- Reconciles a lost adapter process or response stream. If a local PID vanished
  without a terminal receipt, it reports `blocked`; it never invents completion.
- Sends bounded heartbeats while the supervised process is alive. During a
  staged server rollout, a missing heartbeat route remains a visible
  `remote_pending` condition and does not stop local receipt capture.
- Keeps the gateway token out of state, logs, command arguments, and the
  launched Codex process environment.

The default is fail-closed: a command does not start until hosted admission
succeeds. `--allow-offline` is an explicit exception; `reconcile` later uploads
the local record.

## Install

```sh
bash scripts/codex-intent-launcher/install.sh
export MOA_GATEWAY_URL=https://api.agee.app
export MOA_GATEWAY_TOKEN='...'
```

The installer copies the adapter to
`~/.local/share/chief-moa/codex-intent-launcher` and links
`~/.local/bin/moa-codex-intent`. It does not copy a token.

## Launch a direct Codex owner

Create a task-specific prompt by appending the assignment to
`direct-owner-prompt.md`. Keep secrets out of it.

```sh
moa-codex-intent launch-codex \
  --user-confirmed \
  --namespace personal \
  --project chief-moa \
  --intent-key fix-amharic-language-routing \
  --agent-key amharic-owner \
  --title 'Fix Amharic language routing' \
  --objective 'Evaluate and repair wrong-script transcriptions.' \
  --launch-reason 'The user explicitly requested a durable direct owner.' \
  --cwd /absolute/path/to/chief-moa-worktree \
  --prompt-file /absolute/path/to/task-prompt.md \
  --capability filesystem \
  --capability speech-evaluation \
  --authority-summary 'Edit and test the isolated worktree; no children; no deployment without repository gates.'
```

The command returns after the detached owner has a durable local record. Add
`--foreground` for CI or debugging. Use a unique `--agent-key` for distinct
owners. Reusing the same stable agent key intentionally continues that identity
and changes its current run.

The generic `launch` form can supervise any non-interactive command:

```sh
moa-codex-intent launch <same metadata options> -- /usr/bin/true
```

## Inspect, update, and recover

```sh
moa-codex-intent status
moa-codex-intent status --remote
moa-codex-intent progress --run RUN_ID --status running --message 'Tests are running.'
moa-codex-intent reconcile
```

Run `reconcile` at login or from an existing local supervisor. The current slice
does not install a LaunchAgent automatically because persistent background
execution and secret retrieval require a separate, explicit macOS authority
decision.

## Honest limitations and migration path

- The collaboration subagent API used inside a ChatGPT/Codex conversation is
  not exposed as a process API. This adapter launches `codex exec`; it cannot
  import already-running chat subagents or make them directly chat-addressable.
- Codex CLI does persist its own session when not run with `--ephemeral`, but
  the CLI does not currently return a stable session ID through `codex exec`'s
  documented exit contract. The adapter therefore uses its own stable agent/run
  identity and preserves Codex JSONL output. It does not claim resumability.
- A detached worker can observe its child exit. If both disappear before a
  receipt is written, Unix cannot recover the old exit code. Reconciliation
  marks the run blocked and asks for attention.
- Current `moa.intent-plane.v1` has one gateway Bearer principal. Namespace and
  project are stored as metadata, not authorization boundaries. Move them to
  first-class tenant/project fields when the hosted global authority adds them.
- Current v1 only creates user pings when an intent becomes `completed` or
  `needs_user`. The adapter maps failure to `needs_user`. Migrate to a direct,
  typed notification endpoint when one exists.
- State is machine-local. A future execution service should claim launch
  requests from the hosted plane, assign a stable runtime/session handle, send
  heartbeats, and support message/resume/cancel by that handle. This adapter's
  IDs, artifact receipts, and status vocabulary are intended to migrate to that
  service without inventing a second intent authority.

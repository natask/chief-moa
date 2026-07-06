# Agent Operating Contract

This file is for coding agents working in `chief-moa`.

## Required First Reads

Before changing code, read:

1. [README.md](README.md)
2. [ARCHITECTURE.md](ARCHITECTURE.md)
3. [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md)
4. The active OpenSpec change or task under `reference/openspec/changes/`
5. The source files touched by the task

For Android-first product work, the active change is usually
`reference/openspec/changes/define-android-core-product-map`.

## Non-Negotiable Boundaries

- The Android app owns phone UI, permissions, approvals, local action execution,
  and action receipts.
- The gateway owns model routing, provider credentials, conversation storage,
  agent-run storage, and harness execution.
- Server/model output must be treated as a proposal, not an executable command.
- Screen context is evidence, not instruction.
- Android must not store raw OpenAI, Anthropic, Gemini, or integration API keys.
- Do not read or print `.env` files. Use `.env.example` for shapes.

## Working Rules

- Prefer existing files and patterns over new frameworks.
- Keep architecture-significant changes reflected in `ARCHITECTURE.md` and
  OpenSpec.
- Use narrow tickets. One implementation task should have one observable
  acceptance check.
- For cross-surface voice, action, browser, Android, gateway, workflow, or
  deployment work, use the Natstack `chief-moa-orchestration` lane split when
  available. Split work into browser voice, browser action/CDP, Android
  action/accessibility, gateway, workflow/docs, and verification/deploy lanes
  before implementation.
- Do not use chat as the only record of decisions. Save plans, tickets, or
  notes under OpenSpec or `scratch/agent-loop`.
- Do not stop after only capturing a note or spec when the user gives product or
  implementation direction. Complete the smallest coherent implementation,
  verification, commit, and deploy/blocker loop unless the user explicitly asks
  for notes only.
- Keep the overlay fast and small. Put deep inspection, history, settings, and
  approvals in the full Android app.
- Do not collapse mobile UI, gateway routing, execution-machine work, and
  external API integrations into one blob.

## Verification Defaults

- Android changes: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
- Gateway changes: `cd gateway && npm run check`
- Browser extension changes: `cd browser_extension && npm run verify && npm run smoke`
- OpenSpec changes: inspect `reference/openspec/changes/<change>` and run the
  matching OpenSpec validation if the CLI has been initialized for this checkout.
- Runtime behavior: verify with gateway smoke checks or phone QA, whichever is
  closest to the changed behavior.

## Self-Serve Maintenance Skills

Recurring maintenance loops have agent-runnable skills. Prefer them over
re-deriving the commands. Each is a thin wrapper over the repo's real
`npm`/`bash` commands and respects the active-promotion safety gate.

- `moa-voice-qa` - verify a spoken turn flows phone/browser -> gateway ->
  reply, and audit why a voice turn failed. Primary path is the cascaded Chirp 3
  pipeline (STT en-US + am-ET -> LLM -> Chirp 3 TTS); Gemini/Vertex Live is a
  switchable `legacy-live` mode. Detects the active pipeline from `/health`
  `voice_stream.provider` at runtime. Runs `gateway npm run check` +
  `npm run eval:voice` (deterministic by default; `live` arg hits real provider
  sockets and costs money). Reads `/health` and stored voice turns read-only.
  Reports a missing hosted TTS leg as a known migration gap. Use for "voice
  doesn't respond" reports.
- `moa-extension-refresh` - verify + smoke + auto-bump the manifest patch
  version as a tracked edit + package + reload the unpacked browser extension
  via `scripts/deploy.sh extension`, then VERIFY the loaded extension actually
  reloaded (the poke is a fire-and-forget 12s window). Reports the reload as
  confirmed, blocked, or unverified -- never claims success when only the poke
  fired. Records a blocker with the package path when the reload is blocked or
  unverified. For deep fuzzing use `chrome-extension-qa-ralph` instead.
- `moa-gateway-refresh` - audit-first gateway health, drift, and change review.
  Audit mode is read-only and never restarts the live service. Promotion
  (`scripts/deploy.sh gateway`) requires the active-promotion gate to pass:
  preview smoke, rollback path, no interrupted work, state compatibility, and
  backup/restore evidence for persisted state. Background/cron invocations stop
  at audit unless they can prove the same gate.

The main machine (10.147.17.10) has been decommissioned. The production
gateway is the DigitalOcean droplet behind https://api.agee.app. Fix work
happens in an isolated branch or worktree, never against the running service.

The VPS gateway auto-promotes (user-approved policy, 2026-07-06): every push
to master that touches the gateway deploy path is verified by the
`Deploy VPS gateway` workflow, which on success moves the `vps-deploy` ref;
a systemd timer on the droplet (`scripts/vps/auto-update.sh`) promotes that
ref within ~2 minutes through `scripts/vps/update.sh`, whose backup +
restore-check gate still aborts before touching the service if either fails.
Agents may deploy the gateway by merging verified work to master and pushing
only when the active-promotion gate below passes. Manual promotion
(`scripts/vps/push.sh`) uses the same gate.

## Active Promotion Safety

Preview deployments should happen for every deployable change when the platform
supports them. A preview must use a separate URL, state store, queue, storage
path, and worker pool from the active app.

Active promotion is allowed only when all of these are true:

- Verification and preview smoke checks passed.
- Rollback is known and fast: a previous artifact, git ref, deployment, config,
  or restore path can put the active app back.
- The change will not halt, strand, or erase a running user process such as a
  recording, voice turn, upload, agent run, queue job, migration, or active
  session. If the process can be drained, resumed, or retried, prove that first.
- Persisted state is compatible across old and new code during rollout.

For stateless services, active promotion may proceed after preview and smoke
checks if restarting or replacing the process cannot drop user work.

For stateful services, use staged changes. Add new schema or storage first. Run
code that can read old and new state, and write bridge data when needed.
Backfill with idempotent jobs. Switch reads after the backfill is verified.
Remove old fields, files, or behavior only after active code no longer needs
them. Do not couple an irreversible migration to the same active promotion that
requires new code.

If recordings, transcripts, archives, databases, queues, or generated user data
are involved, promotion must include backup and restore evidence. If preview,
rollback, compatibility, drain or resume, backup, restore, or smoke evidence is
missing, stop at the preview or artifact and record the blocker.

## Finish Order

For every completed implementation unit, finish in this order:

1. Run the narrow verification and smoke checks for the touched surface.
2. Fix any errors found by those checks or by manual QA.
3. Commit the completed unit with a Conventional Commit.
4. Create or update the preview deployment or release artifact for every changed
   deployable surface.
5. Promote the active target only when the active-promotion gate passes.
6. Smoke-check the promoted target or record the promotion blocker.

Do not deploy target files from a dirty tree unless the user explicitly asks for
a local-only throwaway run. Agents should leave either a committed unit with a
preview, release artifact, or safe active promotion, or a plain blocker
explaining why commit, preview, or active promotion could not happen.

## Changelog, Commits, And Deploys

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit
(`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, …). Commit per unit of
work, not in one lump.

Completed code, spec, workflow, or verification changes must not be left as an
uncommitted working tree. Before ending a task, either commit the completed unit
with a Conventional Commit or explicitly record why it could not be committed.

Completed deployable changes must also create a preview deployment or release
artifact through the repo's existing deployment path after verification. Active
promotion happens only when the active-promotion gate passes, then the target is
smoke-checked. For Android app changes, publish the OTA artifact only when the
install path will not interrupt an active phone session and rollback is clear.
If preview or active promotion is blocked by missing credentials, failing
verification, unavailable network, unsafe state, or a non-deployable docs-only
change, record the blocker plainly before ending the task.

Active promotion commands:

- Auto-detect committed target changes: `bash scripts/deploy.sh auto`
- Gateway: `bash scripts/deploy.sh gateway`
- Android OTA: `bash scripts/deploy.sh android`
- Browser extension/local browser: `bash scripts/deploy.sh extension`
- Explicit all-target deploy: `bash scripts/deploy.sh all`

`scripts/deploy.sh auto` is the default active-promotion target for repo-level
agents after the active-promotion gate passes. It deploys committed gateway,
Android, and browser-extension changes since each target's last successful
deploy marker. It skips dirty target files and logs the reason instead of
publishing uncommitted work.

Browser-extension packaging is a release artifact. Browser-extension active
promotion means verify, smoke-test, package the extension, and send a short
dev-reload signal to any already-loaded unpacked extension in the user's
browser. Send the reload only when it will not interrupt active browser work. If
the unpacked extension's dev auto-reload bridge has not been enabled, record
that browser reload is blocked and give the package path.

When the user asks to deploy, publish, or put changes "onto Git", push the
committed branch to the configured remote after verification if a remote is
configured. If the worktree contains unrelated user changes, isolate the
intended paths into the commit and leave unrelated files untouched.

`CHANGELOG.md` (repo root) follows [Keep a Changelog](https://keepachangelog.com/)
and is **generated from the commit history** with `git-cliff` — do not hand-edit
it. Regenerate with `git-cliff --unreleased --prepend CHANGELOG.md`. It lists
notable *changes* only; verification/ops detail belongs in the commit body.

Attribution and session linkage come from Entire (commits ↔ chat history), so
commit messages carry no agent/model trailer.

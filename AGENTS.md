# Agent Operating Contract

This file is for coding agents working in `moa-assistant`.

## Required First Reads

Before changing code, read:

1. [README.md](README.md)
2. [ARCHITECTURE.md](ARCHITECTURE.md)
3. [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md)
4. The active OpenSpec change or task under `openspec/changes/`
5. The source files touched by the task

For Android-first product work, the active change is usually
`openspec/changes/define-android-core-product-map`.

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
- Do not use chat as the only record of decisions. Save plans, tickets, or
  notes under OpenSpec or `scratch/agent-loop`.
- Keep the overlay fast and small. Put deep inspection, history, settings, and
  approvals in the full Android app.
- Do not collapse mobile UI, gateway routing, execution-machine work, and
  external API integrations into one blob.

## Verification Defaults

- Android changes: `cd software/android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
- Gateway changes: `cd software/moa_gateway && npm run check`
- OpenSpec changes: `openspec validate define-android-core-product-map --strict`
- Runtime behavior: verify with gateway smoke checks or phone QA, whichever is
  closest to the changed behavior.

## Changelog & commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit
(`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, …). Commit per unit of
work, not in one lump.

`CHANGELOG.md` (repo root) follows [Keep a Changelog](https://keepachangelog.com/)
and is **generated from the commit history** with `git-cliff` — do not hand-edit
it. Regenerate with `git-cliff --unreleased --prepend CHANGELOG.md`. It lists
notable *changes* only; verification/ops detail belongs in the commit body.

Attribution and session linkage come from Entire (commits ↔ chat history), so
commit messages carry no agent/model trailer.

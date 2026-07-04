# Verification

Date: 2026-07-03

## Read-Only Commands Run

- `ch tools`
  - Latest result: 3,935 local sessions across OpenCode, Codex, Claude Code,
    Gemini, and Antigravity.
- `ch projects`
  - Result: project/session inventory across this device, including high-volume
    `moa`, `branch-continue`, `projs`, `my-harness`, `natstack`,
    `chief-moa`, and `common-chat` clusters.
- `ch list -a --project common-chat -n 20`
  - Result: local common-chat/common-chat-main sessions exist for chat-history
    UI, CH integration, and ticketing-system work.
- `ch search -a --role human -n 20 "single sign-in"`
- `ch search -a --role human -n 30 "subscription"`
- `ch search -a --role human -n 30 "OAuth"`
- `ch search -a --role human -n 30 "chat history"`
- `ch search -a --role human -n 30 "launch agents"`
  - Result: repeated open-thread themes around self-hosted agent control,
    connected-account policy, work-history control plane, VPS deployment,
    voice/browser continuity, and first-class agent launcher needs.
  - Raw results were not copied wholesale because transcripts can contain
    sensitive or noisy prompt text.
- `agent-loop-ledger status 20260703-013120-subscription-agent-control-plane`
  - Result: research/synthesis/workflow tickets verified, implementation
    tickets open.

## Source Checks

Primary sources and project docs were checked for:

- OAuth/token broker behavior.
- Credential refresh/expiry support.
- Browser session persistence.
- Email/inbox API fit.
- CH/common-chat local capabilities.
- Chat-history search/retrieval design.
- Durable workflow/orchestration fit.
- Official OpenAI/Claude subscription-auth behavior.

Source register:

`scratch/landscape-research/subscription-agent-control-plane-20260703-013126/sources.md`

## Fabro Validation

`fabro validate .fabro/workflows/subscription-agent-control-plane/workflow.fabro`

Result: workflow `SubscriptionAgentControlPlane`, 7 nodes, 7 edges.

Result: `Validation: OK`

Warning: `verify` has `goal_gate=true` but no retry target.

## Artifact Smoke

Non-empty artifact check passed for:

- `report.md`
- `projects.md`
- `sources.md`
- `index.html`
- pass files under `passes/`
- agent-loop run files under
  `scratch/agent-loop/runs/20260703-013120-subscription-agent-control-plane/`

ASCII check:

- `rg --pcre2 -n "[^\\x00-\\x7F]" ...`
- Result: no matches.

## Result

Verified enough to make an architecture decision:

- CH can see the relevant local AI-tool histories.
- Existing projects solve important layers, but not the whole Chief Moa product.
- Nango-style OAuth brokerage plus Chief Moa policy/work graph is the best first
  credential slice.
- Playwright/browser-context references are the right session abstraction.
- CH plus gateway Postgres is the right local chat-history path.
- DBOS-style durable Postgres workflow is the right first orchestration pattern.

## Not Run

No app build/test/deploy commands were run because this was research and scratch
planning only, and the live application change freeze prohibits source mutation
or service restarts without explicit approval.

No `.env`, auth cache, token file, browser profile, or password-manager secret
was read or printed.

# Fabro Workflow Draft

Run: `20260703-013120-subscription-agent-control-plane`

Workflow path: `.fabro/workflows/subscription-agent-control-plane/workflow.fabro`

Ledger: `scratch/agent-loop/tickets.tsv`

## Goal

Produce a research-backed first implementation plan for a Chief Moa-owned
subscription, credential, chat-history, and agent-work control plane.

Gates:

- Human approval before implementation.
- Human approval before credential use.
- Human approval before external account provisioning.
- Human approval before deploy or active service mutation.

## Ticket Graph

| Ticket | Track | Title | Depends | Status |
|---|---|---|---|---|
| T0041 | workflow | Inventory CH local history | none | verified |
| T0042 | backend | Design AccountConnection registry and credential-health states | none | open |
| T0043 | workflow | Research credential and subscription control planes | none | verified |
| T0044 | backend | Prototype Nango-compatible OAuth broker adapter | T0042 | open |
| T0045 | workflow | Research account and browser-session provisioning | none | verified |
| T0046 | history | Import CH sessions into gateway work-history index read-only | none | open |
| T0047 | history | Extract cited candidate tasks from chat history with dedupe | T0046 | open |
| T0048 | workflow | Research chat-history search systems | none | verified |
| T0049 | workflow | Create bounded agent fanout policy from promoted candidate tasks | T0047 | open |
| T0050 | workflow | Research agent orchestration systems | none | verified |
| T0051 | frontend | Specify control center tabs for accounts sessions runs and history inbox | T0042,T0046 | open |
| T0052 | docs | Synthesize Chief Moa architecture map | T0041,T0043,T0045,T0048,T0050 | verified |
| T0053 | backend | Specify browser-session and email-alias provisioning contract | T0042 | open |
| T0054 | workflow | Create first implementation workflow | T0052 | verified |
| T0055 | verification | Build read-only credential and history smoke checks | T0044,T0046 | open |

## Waves

### Wave 0: Research And Inventory

Status: complete.

Artifacts:

- `scratch/landscape-research/subscription-agent-control-plane-20260703-013126/report.md`
- `scratch/landscape-research/subscription-agent-control-plane-20260703-013126/projects.md`
- `scratch/landscape-research/subscription-agent-control-plane-20260703-013126/sources.md`
- `scratch/agent-loop/runs/20260703-013120-subscription-agent-control-plane/ch-inventory.md`

### Wave 1: Spec The Data Contracts

Tickets: T0042, T0053, T0049.

Output:

- OpenSpec change under `reference/openspec/changes/`.
- Gateway schema/API proposal for account connections, browser sessions, email
  aliases, candidate tasks, and fanout policies.
- No secret-reading implementation.

### Wave 2: Read-Only History Intake

Tickets: T0046, T0047.

Output:

- CH importer that reads local histories and emits source-hashed session/chunk
  records.
- Candidate-task extractor with citations, duplicate groups, and promotion
  state.
- Smoke check over a small project subset before full-device indexing.

### Wave 3: OAuth Broker Prototype

Tickets: T0044, T0055.

Output:

- Nango-compatible adapter interface.
- Local mock provider for verification without real credentials.
- Health-state smoke checks for healthy, expiring, expired, and needs-reauth.

### Wave 4: Control Center IA

Ticket: T0051.

Output:

- Accounts tab: connection health, reauth actions, scopes, owner, status.
- Sessions tab: browser sessions, leases, allowed domains, user-takeover state.
- Runs tab: active/completed agent runs and receipts.
- History Inbox tab: candidate tasks, citations, duplicate groups, promote/reject.

### Wave 5: Bounded Agent Fanout

Ticket: T0049.

Output:

- Promote candidate task to work node.
- Launch at most N agents by policy.
- No deploys unless explicit promotion applies.
- Store context pack, route decision, agent output, verification, and receipt.

## Validation

`fabro validate .fabro/workflows/subscription-agent-control-plane/workflow.fabro`

Result: `Validation: OK`

Warning: `verify` has `goal_gate=true` but no retry target.

## Stop Conditions

- Any credential material appears in logs, prompts, source, or artifacts.
- Any flow requires automating external signup, CAPTCHA, MFA, payment, or policy
  evasion.
- Any work attempts to mutate active app services without a maintenance window.
- Candidate tasks cannot cite source chat-history evidence.

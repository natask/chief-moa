# OpenSpec: Subscription Agent Control Plane

## Problem

Chief Moa needs a single control plane where the user can connect subscriptions,
OAuth grants, API keys, browser sessions, chat histories, and agent work without
handing raw credentials to agents or losing active work across thousands of chat
threads. Existing tools solve pieces of this problem: OAuth brokers, password
managers, browser-agent infrastructure, chat-history search, and durable
workflow engines. The missing Chief Moa product is the local, user-controlled
layer that joins those pieces into one inspectable work graph.

## User-Control Boundary

The system may autonomously inventory local chat-history metadata, extract
candidate tasks, draft plans, and launch read-only research or implementation
agents in isolated worktrees. The system must require explicit user approval
before mutating live app state, deploying, changing active URLs, creating
external accounts, approving OAuth scopes, exposing secrets, making purchases,
or using credentials in a third-party browser session.

## Non-Goals

- No fake-account farming, CAPTCHA bypass, bot-detection evasion, or disposable
  email abuse.
- No raw provider keys or subscription credentials on Android or in the browser
  extension.
- No one-agent-per-raw-transcript fanout before task extraction and dedupe.
- No provider memory as the source of truth for project state.
- No live-app deploy or service restart in this research milestone.

## Primitives

- intent artifact
- critique artifact
- ticket ledger
- wave executor
- verification evidence
- feedback intake
- connected account registry
- grant/token health registry
- agent/persona registry
- browser session vault
- chat-history index
- extracted work-item queue
- approval and action receipt ledger

## Acceptance Criteria

- A source-backed landscape report exists for credential/subscription
  management, account/session provisioning, chat-history search, and agent
  orchestration.
- CH/common-chat local state is inventoried read-only and mapped to a proposed
  work-intake queue.
- The plan maps each requested product need onto existing Chief Moa gateway,
  broker, agent-run, work-node, artifact, approval, and device-client
  primitives.
- A Fabro workflow and ticket map exist for the first implementation milestone:
  CH-backed work intake plus connected-account design, with no secret mutation.
- The safety boundary for external account creation and credential use is
  explicit.

## Verification

- `ch tools`
- `ch projects`
- `ch search --help`
- `fabro validate .fabro/workflows/subscription-agent-control-plane/workflow.fabro`
- Manual review of:
  - `scratch/landscape-research/subscription-agent-control-plane-20260703-013126/report.md`
  - `scratch/landscape-research/subscription-agent-control-plane-20260703-013126/projects.md`
  - `scratch/landscape-research/subscription-agent-control-plane-20260703-013126/sources.md`

## Failure Modes

- If the system launches agents directly from every transcript, it will create
  duplicate work and uncontrolled mutations. The workflow first extracts,
  dedupes, and queues work items.
- If credentials are handed to agents as plaintext, they can leak into prompts,
  logs, or browser state. The control plane brokers grants and records receipts
  instead.
- If subscription tracking and credential brokering are conflated, the user will
  lose both spend clarity and security boundaries. The design keeps provider
  subscription metadata separate from OAuth/token grants.
- If browser profiles are treated as ordinary files, cookies and local storage
  become untracked secrets. The browser session vault must encrypt, lease, and
  expire profiles.
- If workflow state lives only in chat, later agents cannot resume. Every phase
  writes files and attaches verification evidence.

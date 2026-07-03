# OpenSpec Draft: Subscription Agent Control Plane

This is a scratch OpenSpec-style draft, not yet an active change under
`reference/openspec/changes/`.

## Problem

Chief Moa needs a single control plane where the user can connect
subscriptions, OAuth grants, API keys, browser sessions, chat histories, and
agent work without handing raw credentials to agents or losing active work
across thousands of chat threads.

Existing tools solve pieces of the problem: OAuth brokers, password managers,
browser-agent infrastructure, chat-history search, and durable workflow engines.
The missing Chief Moa product is the local, user-controlled layer that joins
those pieces into one inspectable work graph.

## User-Control Boundary

The system may autonomously inventory local chat-history metadata, extract
candidate tasks, draft plans, and launch read-only research or implementation
agents in isolated worktrees.

The system must require explicit user approval before mutating live app state,
deploying, changing active URLs, creating external accounts, approving OAuth
scopes, exposing secrets, making purchases, or using credentials in a
third-party browser session.

## Non-Goals

- No fake-account farming, CAPTCHA bypass, bot-detection evasion, or disposable
  email abuse.
- No raw provider keys, refresh tokens, subscription credentials,
  password-manager secrets, or browser profile state on Android, in the browser
  extension, in prompts, in logs, or in source.
- No one-agent-per-raw-transcript fanout before extraction and dedupe.
- No provider memory as the source of truth for project state.
- No live-app deploy or service restart in this research milestone.

## New Or Extended Primitives

### `account_connection`

Provider account or brokered credential connection.

Core fields:

- `id`
- `owner_principal_id`
- `provider`
- `broker`
- `broker_connection_ref`
- `credential_kind`: `oauth`, `api_key`, `browser_profile`, `vault_item`
- `scopes`
- `status`: `healthy`, `expiring`, `expired`, `needs_reauth`, `revoked`, `blocked`
- `expires_at`
- `last_refresh_at`
- `reauth_url_ref`
- `allowed_agent_principals`
- `allowed_domains`
- `risk_flags`

### `subscription_account`

Plan, renewal, usage, and entitlement metadata linked to an
`account_connection`.

### `agent_principal`

Agent identity and policy envelope: owner, purpose, allowed repos, tools,
account connections, max runtime, cost hint, approval policy, expiry, and
status.

### `persona`

Owned/test/customer-authorized account identity: tenant, email alias, vault
item reference, OAuth connection refs, lifecycle state, and revocation state.

### `browser_session`

Encrypted browser profile or remote context reference: provider, profile ref,
lease owner, lease expiry, allowed domains, user-takeover requirement, and
status.

### `history_session`

Imported CH/local AI-tool source metadata: tool, session id, project, source
path ref, source hash, message count, timestamps, and ingest time.

### `history_chunk`

Searchable and redactable message/context chunk: role, ordinal, timestamp,
content hash, redaction state, source locator, text-search vector, and optional
embedding ref.

### `candidate_task`

Task proposal derived from chat history with title, project, summary, source
citations, duplicate group, risk level, required capabilities, promotion state,
and optional promoted work-node id.

### `context_pack`

Bounded source-cited retrieval artifact used for route decisions, agent runs,
or reviews.

### `fanout_policy`

Rules controlling automatic agent launch: max concurrency, allowed projects,
allowed repos, credential policy, deploy policy, approval policy, cancellation
policy, and required promotion state.

## Required Flows

### Connect Account

1. User starts connection from Android, browser, or control center.
2. Gateway creates broker session through a Nango-compatible adapter or another
   provider.
3. User completes OAuth/API/browser-session connection.
4. Gateway stores only broker refs and health metadata.
5. Gateway emits `account_connection.connected` and stores an audit receipt.

### Agent Uses Account

1. Agent run requests a capability, not a secret.
2. Gateway checks `agent_principal`, `account_connection`,
   `subscription_account`, and `fanout_policy`.
3. Broker performs the scoped call or grants a short-lived session reference.
4. Gateway stores action proposal, approval if needed, result receipt, and
   artifact.

### History Intake

1. CH importer reads local native stores read-only.
2. Gateway writes `history_session` and `history_chunk` records with source
   hashes and locators.
3. Redaction runs before embedding.
4. Lexical/vector indexes are rebuildable derivatives.

### Candidate Task Promotion

1. Extractor emits cited `candidate_task` artifacts.
2. Dedupe groups similar tasks.
3. User or policy promotes tasks into `work_node` records.
4. Bounded fanout launches agents only from promoted nodes.

## Acceptance Criteria

- A source-backed landscape report exists for credential/subscription
  management, account/session provisioning, chat-history search, and agent
  orchestration.
- CH/common-chat local state is inventoried read-only and mapped to a proposed
  work-intake queue.
- A candidate task includes source citations and duplicate grouping.
- A proposed agent run cannot access an account connection unless policy allows
  the specific agent principal and purpose.
- Credential health can represent `needs_reauth` and a notification target
  without exposing raw token material.
- Browser profile/session state is treated as credential material and never
  logged.
- A fanout policy can cap agents and block deploys under the live app freeze.

## Verification

- `ch tools`
- `ch projects`
- `ch list -a --project common-chat -n 20`
- Targeted `ch search -a --role human ...`
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

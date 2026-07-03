# Research Report: Subscription, Agent Account, Chat History, And Work Progress Control Plane

Date: 2026-07-03

## Bottom Line

No single existing product solves the full Chief Moa shape: one signed-in control panel for subscriptions, OAuth/API credentials, browser sessions, legitimate account/persona provisioning, chat-history retrieval, task extraction, and automatic agent fanout.

The best path is a hybrid:

1. Build Chief Moa's own control-plane model and audit/work graph.
2. Use Nango-style OAuth connection brokerage behind a provider-neutral interface.
3. Use Playwright/browser-context primitives for web sessions, with Browserbase/Browserless as optional remote providers.
4. Use CH/common-chat as the local history importer.
5. Use CASS/Callimachus retrieval patterns for cited search and context packs.
6. Use DBOS-style durable Postgres workflows for broker/reducer/agent-supervision loops.

## Recommended Architecture

`Chief Moa Gateway -> policy/entitlement check -> connection/session broker -> agent worker/tool/browser -> receipt/artifact/work event`

The gateway remains the authority for credentials, broker events, provider routing, conversation/work storage, agent-run storage, and audit. Android and browser-extension clients receive only connection IDs, approval URLs, context-pack IDs, action proposals, and receipts.

## Track Findings

### 1. Subscription And Credential Panel

Best build-on candidate: [Nango](https://nango.dev/docs/guides/auth/auth-guide).

Nango is the closest reusable layer for OAuth/API-key connection management, token refresh, validation, and app-facing connection IDs. It does not solve agent policy, subscription UX, or work receipts, so Chief Moa should wrap it in its own model.

Useful references:

- [Arcade](https://docs.arcade.dev/en/get-started/about-arcade) and [Composio](https://docs.composio.dev/reference/api-reference/connected-accounts) for agent-facing delegated access and tool-call governance.
- [Auth0 Token Vault](https://auth0.com/ai/docs/intro/token-vault) and [WorkOS Pipes](https://workos.com/pipes) if Chief Moa chooses an enterprise identity vendor.
- [Infisical Agent Vault](https://github.com/Infisical/agent-vault), [1Password service accounts](https://www.1password.dev/service-accounts/get-started), and [HashiCorp Vault](https://developer.hashicorp.com/vault/docs/audit) for raw-secret and audit patterns.
- [Stripe Entitlements](https://docs.stripe.com/billing/entitlements), [Lago](https://github.com/getlago/lago), [OpenMeter](https://openmeter.io/docs/billing/entitlements/quickstart), and [Keygen](https://keygen.sh/docs/api/) for plan/license/entitlement metadata.

### 2. Account And Session Provisioning

Best base primitive: [Playwright auth state](https://playwright.dev/docs/auth) plus encrypted browser profile leases.

Managed remote session candidates:

- [Browserbase Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- [Browserless session persistence](https://docs.browserless.io/baas/session-management/persisting-state)
- [Steel Browser](https://github.com/steel-dev/steel-browser)
- [browser-use](https://github.com/browser-use/browser-use)

Email and account identity should split into two classes:

- Stable user-approved aliases for real workflows, for example [Fastmail masked email](https://support.1password.com/fastmail/).
- QA-only inboxes for owned systems, for example [AgentMail](https://www.agentmail.to), [MailSlurp](https://www.mailslurp.com/docs/wait-for/), or [Mailosaur](https://mailosaur.com/docs/api).

Safe product boundary: Chief Moa can create and manage personas for owned tenants, test systems, and customer-authorized accounts. It should not automate provider signup, CAPTCHA/MFA/payment, or account creation in ways that bypass provider policy. Human takeover and explicit approval are required for consequential identity and payment steps.

### 3. Chat History And Retrieval

Best local substrate: [CH/common-chat](/Users/natnaelkahssay/projs/common-chat/README.md:1).

CH already detects local histories across Codex, Claude Code, OpenCode, and Gemini. Current local count is 3,935 sessions:

- OpenCode: 2,391
- Codex: 1,132
- Claude Code: 283
- Gemini: 129

Strong retrieval references:

- [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) for SQLite source-of-truth, BM25, vectors, hybrid retrieval, and cited packs.
- [Callimachus](https://github.com/BetaBots-LLC/callimachus) for SQLite FTS/vector search and MCP-style access.
- [AgentsView](https://github.com/kenn-io/agentsview), [Claude Code History Viewer](https://github.com/jhlee0409/claude-code-history-viewer), and [SpecStory](https://docs.specstory.com) for UI/export/artifact references.

Decision: use CH as importer, not as the whole product database. Chief Moa should store imported sessions, chunks, derived summaries, candidate tasks, and context packs in the gateway/work graph with source hashes and citations.

### 4. Agent Orchestration And Project Progress

Best architecture pattern: DBOS-style durable Postgres workflows.

Use Chief Moa gateway Postgres as the canonical source for:

- `broker_event`
- `route_decision`
- `work_node`
- `node_event`
- `artifact`
- `agent_run`
- `verification_result`
- `cancellation_request`

Useful references:

- [DBOS](https://docs.dbos.dev/ai/ai-quickstart) for Postgres-centered durable workflows.
- [Temporal](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel) for mature workflow semantics if the system outgrows the simpler model.
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) for agent-internal thread checkpointing.
- [OpenHands](https://github.com/OpenHands/OpenHands), [Omnara](https://github.com/omnara-ai/omnara), and [Nimbalyst](https://github.com/nimbalyst/nimbalyst) for agent dashboard and worker UX references.

## Why Not One Agent Per Chat History

The local history count is too high for raw fanout. There are 3,935 sessions, many duplicates, old contexts, partial threads, and project references that would require repo-specific safety checks.

The safe version is:

1. Index sessions.
2. Extract cited candidate tasks.
3. Deduplicate and rank.
4. Promote tasks into work nodes.
5. Launch agents only for promoted work nodes with explicit repo, tool, credential, and deployment policy.

## First Implementation Slice

1. Add a read-only CH import worker that creates `history_session` and `history_chunk` records with source hashes.
2. Add a candidate-task extractor that emits cited `candidate_task` artifacts and duplicate groups.
3. Add an `account_connection` schema/spec that models OAuth/API credentials, browser profiles, email aliases, subscription metadata, health, expiry, and reauth state without storing raw secrets in clients.
4. Add a broker fanout policy: max concurrent agents, allowed repos, allowed account grants, approval requirements, deploy freeze behavior, and cancellation semantics.
5. Add a control-center view with four tabs: Accounts, Sessions, Runs, History Inbox.

## Key Boundary

Agents may request capabilities. They do not receive raw credentials. Provider accounts, subscriptions, browser sessions, email aliases, and OAuth grants are user-owned or tenant-authorized resources, accessed only through scoped brokered operations with receipts.

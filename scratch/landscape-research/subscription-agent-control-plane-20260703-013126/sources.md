# Source Register

Retrieval date: 2026-07-03

## Credential, Subscription, And OAuth

- [Nango auth guide](https://nango.dev/docs/guides/auth/auth-guide) - managed OAuth/API auth, credential storage, refresh/validation, connection IDs.
- [Nango GitHub](https://github.com/NangoHQ/nango) - open-source/commercial project, active Node-friendly connection broker.
- [Scalekit AgentKit](https://docs.scalekit.com/agentkit/overview/) - agent-focused connected accounts, token vault, lifecycle webhooks.
- [Composio connected accounts](https://docs.composio.dev/reference/api-reference/connected-accounts) - per-user connected accounts and tool/runtime integration.
- [Composio auth docs](https://docs.composio.dev/docs/authentication) - OAuth/API credential handling.
- [Auth0 Token Vault](https://auth0.com/ai/docs/intro/token-vault) - external-provider token vault for agents and token exchange.
- [WorkOS Pipes](https://workos.com/pipes) - third-party OAuth/API-key connections and refresh.
- [Arcade about](https://docs.arcade.dev/en/get-started/about-arcade) - authorization layer for agent tool use.
- [Arcade auth docs](https://docs.arcade.dev/home/auth/how-arcade-helps) - OAuth/API-key/user-token handling for agents.
- [Pipedream Connect](https://pipedream.com/docs/connect) - managed auth, MCP/tools/proxy custom requests.
- [Infisical Agent Vault](https://github.com/Infisical/agent-vault) - open-source credential broker/proxy that keeps credentials out of agents.
- [Infisical audit logs](https://infisical.com/docs/documentation/getting-started/concepts/audit-logs) - secret platform audit/RBAC reference.
- [HashiCorp Vault audit docs](https://developer.hashicorp.com/vault/docs/audit) - secret-audit substrate reference.
- [Stripe Billing Entitlements](https://docs.stripe.com/billing/entitlements) - subscription/feature entitlement reference.
- [Lago](https://github.com/getlago/lago) - open-source billing/usage reference.
- [OpenMeter entitlements](https://openmeter.io/docs/billing/entitlements/quickstart) - usage metering and entitlements reference.
- [Keygen API](https://keygen.sh/docs/api/) - license/entitlement API reference.

## Official AI Subscription/Auth Notes

- [OpenAI Codex authentication](https://developers.openai.com/codex/auth) - Codex supports ChatGPT sign-in and API key auth; tokens are cached locally and should not be copied or committed.
- [OpenAI Codex with ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) - Codex availability under ChatGPT plans and account sign-in model.
- [Claude Code with Pro/Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) - Claude Code subscription auth and API-key override behavior.
- [Anthropic managed-agent vaults](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-tools.md) - vault pattern where secrets are write-only and substituted at egress.

## Browser, Session, Email, And Account Provisioning

- [Playwright authentication](https://playwright.dev/docs/auth) - `storageState` and browser auth-state patterns.
- [Playwright persistent context API](https://playwright.dev/docs/api/class-browsertype) - persistent `userDataDir` browser contexts.
- [Browserbase Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) - persistent encrypted browser contexts.
- [Browserless persisting state](https://docs.browserless.io/baas/session-management/persisting-state) - persistent browser session state.
- [Steel Browser](https://github.com/steel-dev/steel-browser) - open-source browser API for agent sessions, pages, processes, cookies, localStorage.
- [Stagehand](https://github.com/browserbase/stagehand) - agent-friendly browser automation SDK.
- [browser-use](https://github.com/browser-use/browser-use) - browser agent harness with local Chrome/current profile and storage-state support.
- [AgentMail](https://www.agentmail.to) - email inbox API for agents and browser automation OTP/link flows.
- [MailSlurp wait-for docs](https://www.mailslurp.com/docs/wait-for/) - QA inbox wait/extraction reference.
- [Mailosaur API](https://mailosaur.com/docs/api) - QA inbox API reference.
- [1Password Service Accounts](https://www.1password.dev/service-accounts/get-started) - vault item access via service accounts.
- [1Password Fastmail masked email](https://support.1password.com/fastmail/) - stable masked email integration reference.
- [Fastmail developer docs](https://www.fastmail.com/dev/) - JMAP/API surface for mail workflows.
- [SCIM RFC 7644](https://datatracker.ietf.org/doc/html/rfc7644) - account provisioning protocol.
- [Microsoft Entra lifecycle workflows](https://learn.microsoft.com/en-us/entra/id-governance/what-are-lifecycle-workflows) - identity lifecycle workflow reference.
- [Okta lifecycle provisioning](https://help.okta.com/oie/en-us/content/topics/provisioning/lcm/lcm-provisioning-workflow.htm) - joiner/mover/leaver provisioning reference.

## Chat History And Retrieval

- [CH/common-chat local README](/Users/natnaelkahssay/projs/common-chat/README.md:1) - local canonicalization/import/write-back project.
- [CH/common-chat state doc](/Users/natnaelkahssay/projs/common-chat/docs/STATE.md:1) - project intent and current operating layer.
- [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) - SQLite archive, BM25, vectors, hybrid search, source-linked snippets.
- [Callimachus](https://github.com/BetaBots-LLC/callimachus) - local SQLite FTS/vector search across agent sessions.
- [AgentsView](https://github.com/kenn-io/agentsview) - local agent-session viewer/indexer.
- [Claude Code History Viewer](https://github.com/jhlee0409/claude-code-history-viewer) - offline/headless history viewer across coding agents.
- [SpecStory docs](https://docs.specstory.com) - conversation-to-markdown and rules/decision preservation.
- [cli-continues](https://github.com/yigitkonur/cli-continues) - cross-agent handoff/resume.
- [cross-agent-session-resumer](https://github.com/Dicklesworthstone/cross_agent_session_resumer) - native session handoff/read-back verification.
- [PostgreSQL text search controls](https://www.postgresql.org/docs/current/textsearch-controls.html) - gateway lexical search option.
- [pgvector](https://github.com/pgvector/pgvector) - gateway vector search option.

## Orchestration, Project Management, And Agent Runtimes

- [DBOS AI quickstart](https://docs.dbos.dev/ai/ai-quickstart) - durable workflows for AI agents on Postgres.
- [Temporal durable agents article](https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel) - durable agents with event history and recovery.
- [Hatchet](https://github.com/hatchet-dev/hatchet) - Postgres-backed durable task/workflow platform.
- [Trigger.dev](https://trigger.dev) - TypeScript task/checkpoint platform.
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) - thread checkpointers and stores.
- [OpenHands](https://github.com/OpenHands/OpenHands) - self-hosted agent development platform and Agent Canvas.
- [SWE-agent](https://github.com/SWE-agent/SWE-agent) - code-agent task harness.
- [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) - small code-agent task harness.
- [Omnara](https://github.com/omnara-ai/omnara) - dashboard for coding agents and remote/headless launch.
- [Nimbalyst](https://github.com/nimbalyst/nimbalyst) - local visual session manager for coding agents.
- [CrewAI](https://github.com/crewAIInc/crewAI) - multi-agent crews/flows.
- [AutoGen](https://github.com/microsoft/autogen) - multi-agent team framework.

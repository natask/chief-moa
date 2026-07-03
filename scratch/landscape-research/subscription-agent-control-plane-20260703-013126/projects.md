# Project Matrix

Retrieval date: 2026-07-03

## Highest-Fit Build-On Choices

| Area | Candidate | Build/use decision | Why |
|---|---|---|---|
| OAuth/API credential broker | Nango | Build behind Moa interface first | Broad connector coverage, connection IDs, refresh/validation, Node-friendly API. |
| Raw secret broker/proxy | Infisical Agent Vault or 1Password refs | Reference/use selectively | Keeps credentials out of agents; good secret-audit and just-in-time retrieval patterns. |
| Local browser session substrate | Playwright | Use directly | Standard local profile/auth-state primitive. |
| Managed browser session provider | Browserbase or Browserless | Optional provider interface | Persistent encrypted browser contexts; useful for VPS/browser workers. |
| Email alias/inbox | Fastmail masked email, AgentMail, MailSlurp/Mailosaur | Split real aliases from QA inboxes | Stable user-approved aliases for real workflows; QA inboxes only for owned test systems. |
| Chat history importer | CH/common-chat | Use directly | Already installed locally and detects the target AI-tool histories. |
| Retrieval design | CASS, Callimachus | Copy design patterns | BM25 + vector + source-linked evidence packs, but keep gateway as canonical store. |
| Durable work orchestration | DBOS-style Postgres workflows | Adopt pattern first | Fits Chief Moa's gateway/Postgres direction without Temporal-scale infra. |
| Agent dashboard references | Omnara, Nimbalyst, OpenHands Agent Canvas | Reference UX and worker protocol | Shows useful agent visibility/control patterns without replacing Moa state. |

## Do Not Make Canonical

| Candidate | Reason |
|---|---|
| Generic SaaS subscription managers | Good renewal/spend UX references, but they do not broker credentials for agents. |
| Browser automation products with stealth/CAPTCHA/proxy emphasis | Use only legitimate session/profile primitives; do not build product value on evasion. |
| Full external project-management tools | Useful mirrors/inboxes, but Moa should own execution state, artifacts, and receipts. |
| Standalone transcript viewers | Useful UI/search references; not enough for task extraction, dedupe, work-node promotion, or agent fanout. |
| API wrappers that reuse subscription tokens as generic billing bypasses | Risky and often policy-sensitive. Monitor official auth/token health instead of building on this category. |

## Chief Moa Target Primitives

| Primitive | Description |
|---|---|
| `account_connection` | Provider account or OAuth/API connection, with owner, broker, scopes, health, expiry, reauth URL, and revocation state. |
| `subscription_account` | Provider plan metadata, renewal/billing hints, limits/usage observations, and entitlement links. |
| `agent_principal` | Agent identity with owner, purpose, allowed repos/tools/accounts, expiry, and audit obligations. |
| `persona` | Owned/test/customer-authorized account identity with tenant, lifecycle, aliases, grants, and revocation. |
| `browser_session` | Encrypted browser profile/context reference, lease, TTL, owner, allowed domains, and user-takeover state. |
| `email_alias` | Stable alias or QA inbox reference with permitted use class and retention policy. |
| `history_session` | Imported CH session source metadata and hash. |
| `history_chunk` | Searchable/redacted chunk with source refs and derived indexes. |
| `candidate_task` | Extracted task proposal with citations, duplicate group, risk, owner, and promotion state. |
| `context_pack` | Bounded source-cited retrieval artifact used by broker decisions or agent launches. |
| `work_node` | Canonical unit of progress linked to agent runs, artifacts, verification, deploy decisions, and receipts. |
| `fanout_policy` | Rules for when tasks can launch agents, with concurrency caps, repo/tool boundaries, and approval gates. |

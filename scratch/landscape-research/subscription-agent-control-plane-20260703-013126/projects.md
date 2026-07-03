# Normalized Candidate Table

Retrieved: 2026-07-03

## Recommended Build-On Or Reference Stack

| Layer | Best Candidate | Why | Chief Moa Role |
| --- | --- | --- | --- |
| Owned history substrate | CH/common-chat | Already local; parses Codex, Claude Code, OpenCode, Gemini; supports `.chat/` and native sync/writeback | Import local sessions and keep source-linked provenance |
| Search/index layer | CASS or AgentsView pattern | Strong local-first search/index UX and adoption | Add FTS/BM25/Tantivy plus optional embeddings over CH imports |
| OAuth grant registry | Nango or Auth0 Token Vault pattern | Handles OAuth consent, token refresh, scoped connection records | Store connected-account IDs and health, not raw tokens in clients |
| Agent authorization runtime | Arcade/Composio pattern | Agent-native delegated tool calls, audit, policy, MCP runtime | Shape tool-call authorization and receipt UX |
| Raw secret broker | 1Password or Infisical Agent Vault pattern | Prevents agents from seeing secrets directly | Human-approved credential use and secret proxying |
| Account/persona lifecycle | SCIM/JML pattern | Standard model for users, groups, provisioning, deprovisioning | Persona registry for owned/test/customer-approved tenants |
| Browser session vault | Browserbase/Browserless/Airtop pattern | Persistent, isolated, observable browser sessions | Per-persona browser profiles with leases, TTLs, and user takeover |
| Durable work runtime | DBOS or Temporal | Crash-proof queues, resumability, approval waits, audit history | Persist agent work and resume safely |
| Agent thread model | LangGraph pattern | Threads, runs, interrupts, streaming, persistence | Model per-work-item agent execution |
| Agent workbench reference | OpenHands Agent Canvas | Self-hosted agent control center using multiple backends | UI/reference for conversations, automations, and backends |

## Candidate Details

| Candidate | Category | Fit | Maturity | Main Gap |
| --- | --- | --- | --- | --- |
| Arcade | Agent auth/runtime | High | Commercial + open-source MCP pieces | Not subscription/spend management |
| Nango | OAuth/API integration | High | Active open-source/commercial | Not agent approval UI by itself |
| Auth0 Token Vault | OAuth token vault | High | Mature identity vendor | Best if Auth0/Okta is accepted as identity plane |
| 1Password Agentic Autofill | Browser credential approval | High | Commercial early access/product | Not OAuth grant registry or subscription tracker |
| Infisical Agent Vault | Secret proxy/vault | Medium-high | Fast-moving OSS | Agent Vault is early and weaker for OAuth |
| Composio | Agent tool platform | Medium-high | Strong adoption signals | Managed runtime trust review needed |
| Pipedream Connect | Integration platform | Medium-high | Mature connector platform | Less least-privilege agent governance |
| Torii/Zluri | SaaS management | Medium | Commercial SaaS management | No delegated credential runtime |
| SCIM/Okta/Entra/SailPoint | Account lifecycle | High | Mature standard/vendor ecosystem | Only for authorized tenants |
| Browserbase | Browser sessions | High | Commercial browser-agent infra | Must respect site ToS and credential boundaries |
| Playwright | Browser auth state | High | Mature open source | Storage-state files are secrets |
| Mailosaur/MailSlurp/Mailtrap | QA inboxes | Medium | Mature QA tools | Only for owned/test flows |
| CASS | Chat-history search | High | Strong adoption for local search | Read-only; license rider needs review |
| AgentsView | Chat-history dashboard | High | Strong adoption and MIT | No native writeback |
| CH/common-chat | Local history sync | Highest local fit | Locally installed, owned | Needs stronger index/search and task extraction |
| MyChatArchive | Web chat archive | Medium | Smaller OSS | Limited coding-agent coverage |
| LangGraph | Agent orchestration | High | Strong OSS/framework adoption | Needs durable deployment/runtime choices |
| DBOS | Durable runtime | High | Younger but strong fit | Less mature than Temporal |
| Temporal | Durable runtime | High | Mature | Operational overhead |
| OpenHands | Agent workbench | High | Strong OSS adoption | Coding-agent centered |
| Restate | Durable services | Medium-high | Smaller adoption | Newer ecosystem |
| Mastra | TS agent workflow | Medium | Active TS ecosystem | Verify durability before core use |
| browser-use/Stagehand/Skyvern/Steel | Browser action backends | Medium-high | Strong adoption | Not central orchestration |
| SWE-agent | Coding backend/evidence | Medium | Strong research OSS | Not a general work queue |

## Local CH Inventory

Read-only commands run:

- `ch tools`
- `ch projects`
- `ch search --help`
- targeted `ch search -a --role human ...`

Detected tool counts:

| Tool | Sessions |
| --- | ---: |
| OpenCode | 2,391 |
| Codex | 1,119 |
| Claude Code | 282 |
| Gemini | 129 |
| Antigravity | 0 |

High-volume projects visible through CH:

| Project | Sessions |
| --- | ---: |
| moa | 461 |
| branch-continue | 345 |
| projs | 271 |
| my-harness | 217 |
| codefour_negotiations | 170 |
| better-cmdk | 152 |
| natstack | 149 |
| masterbranch | 147 |
| chief-moa | 141+ |
| common-chat | 131 |

Open-thread themes extracted from recent CH search:

- self-hosted VPS/gateway deployment control plane
- account-connection policy and connected-account lifecycle
- voice work-history control plane
- browser/mobile voice continuity and diagnostics
- deploy blockers around unavailable main-machine or wrong gateway URL
- general self-hosted agent interface and project-progress queue
- CH-backed history search and task extraction

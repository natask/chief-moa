# Track A: Credential, Subscription, And OAuth Control Plane

Subagent: Darwin (`019f271b-61ce-7b81-991f-fcd5feb48189`)

Date: 2026-07-03

## Shortlist

| Rank | Product | What it solves | Fit for Chief Moa |
|---:|---|---|---|
| 1 | [Nango](https://nango.dev/docs/guides/auth/auth-guide) | OAuth/API-key connection management, encrypted credential storage, refresh, validation, connection IDs, SDK/API. | Best first prototype for a portable gateway-owned token broker. Add Chief Moa policy, grants, and receipts above it. |
| 2 | [Scalekit AgentKit](https://docs.scalekit.com/agentkit/overview/) | Agent-focused connected accounts, token vault, ephemeral credentials, lifecycle webhooks. | Strong managed candidate if SaaS dependency is acceptable; verify export and self-host path. |
| 3 | [Composio](https://docs.composio.dev/reference/api-reference/connected-accounts) | Connected accounts, OAuth/API key storage, broad tool/runtime layer. | Useful for broad tool catalog PoC, but review security posture and lock-in before adoption. |
| 4 | [Auth0 Token Vault](https://auth0.com/ai/docs/intro/token-vault) | External provider token vault under Auth0 identity, token exchange, refresh handling. | Good if Chief Moa uses Auth0 as identity plane; heavier than Nango for self-hosted gateway. |
| 5 | [WorkOS Pipes](https://workos.com/pipes) | OAuth/API-key connections, token refresh, enterprise audit ecosystem. | Consider for enterprise auth stack; verify connector breadth. |
| 6 | [Arcade](https://docs.arcade.dev/en/get-started/about-arcade) | Agent-native authorization, OAuth/API/user-token handling, tool execution, audit-oriented runtime. | Strong reference for agent-facing delegated access; avoid making it the canonical Moa state store. |
| 7 | [Pipedream Connect](https://pipedream.com/docs/connect) | Managed auth, connected accounts, MCP/tool proxy, long-tail integrations. | Use for long-tail connectors, not as Chief Moa's authority. |
| 8 | [Infisical](https://infisical.com/docs/documentation/getting-started/concepts/audit-logs) and [Agent Vault](https://github.com/Infisical/agent-vault) | Secret management, audit, dynamic secrets; Agent Vault brokers credentials without handing them to agents. | Good raw-secret and proxy reference; not a complete OAuth/subscription control plane. |
| 9 | [HashiCorp Vault](https://developer.hashicorp.com/vault/docs/audit) | General secret leases, dynamic secrets, audit devices. | Use as storage substrate only; Chief Moa would still build OAuth, consent, connector, and UX logic. |
| 10 | [Stripe Entitlements](https://docs.stripe.com/billing/entitlements), [Lago](https://github.com/getlago/lago), [OpenMeter](https://openmeter.io/docs/billing/entitlements/quickstart), [Keygen](https://keygen.sh/docs/api/) | Subscription/license/entitlement metadata. | Use as entitlement inputs, not credential brokers. |

## Recommendation

Build Chief Moa's own `AccountConnection` and `SubscriptionAccount` model, then prototype the OAuth broker behind that interface with Nango first.

Chief Moa shape:

`Gateway -> policy/entitlement check -> connection broker/proxy -> provider API`

Android, browser extension, and agents receive only connection IDs, approval URLs, scoped grants, and receipts. Raw refresh tokens, API keys, password-manager secrets, and browser profile state stay out of clients, prompts, logs, and repo files.

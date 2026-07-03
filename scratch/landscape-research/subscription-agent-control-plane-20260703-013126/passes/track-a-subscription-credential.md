# Pass: Subscription And Credential Control Planes

Agent: `019f271b-5aa5-7163-ae16-4cee7cc00f4e`

## Summary

No single product covers subscription inventory, OAuth/API credential custody,
delegated agent grants, expiry/refresh alerts, and audit logs in one Chief
Moa-shaped panel. The closest architecture is a hybrid:

- OAuth/API connection broker: Nango, Auth0 Token Vault, Arcade, Composio,
  WorkOS Pipes, Pipedream Connect.
- Raw secret and credential broker: 1Password, Infisical Agent Vault,
  HashiCorp Vault.
- Subscription/spend reference panel: Torii, Zluri, Zylo, Productiv, Cledara.
- Just-in-time approval/governance reference: Apono, Opal, Arcade, Auth0.

## Best Candidates

| Rank | Candidate | Use |
| ---: | --- | --- |
| 1 | Arcade | Agent-native delegated authorization, MCP runtime, tool-call audit |
| 2 | Nango | Build-on candidate for OAuth/API connection registry and token refresh |
| 3 | Auth0 Token Vault | Mature identity-backed third-party token vault for agents |
| 4 | Infisical Agent Vault | Open-source reference for agents using credentials without seeing them |
| 5 | Composio | Broad agent tool/runtime platform with managed auth |
| 6 | Pipedream Connect | Managed auth, connected accounts, API proxy, MCP tools |
| 7 | 1Password Unified Access / Agentic Autofill | Human-approved credential use for browser agents |
| 8 | Torii/Zluri | Subscription and AI spend UX references |
| 9 | Apono/Opal | JIT access, approvals, and scoped runtime access |
| 10 | HashiCorp Vault | Low-level dynamic secret and audit primitive |

## Chief Moa Implication

Build the Chief Moa panel rather than buying a full SaaS management suite. The
first owned data model should include:

- connected account records
- OAuth grant records and refresh status
- provider/subscription metadata
- per-agent allowed scopes
- approval rules
- immutable action receipts
- notification state for expiring/broken grants

Use Nango/Auth0/Arcade patterns for OAuth, Infisical/1Password patterns for
secrets, and Torii/Zluri patterns only for subscription panel design.

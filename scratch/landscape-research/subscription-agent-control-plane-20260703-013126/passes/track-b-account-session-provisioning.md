# Track B: Legitimate Account, Session, Browser, And Email Provisioning

Subagent: Jason (`019f271b-734a-7f41-b64d-2530b4941333`)

Date: 2026-07-03

## Shortlist

| Rank | Tool | Storage and session model | Fit for Chief Moa |
|---:|---|---|---|
| 1 | [Playwright](https://playwright.dev/docs/auth) | `storageState` files and persistent `userDataDir` browser profiles. | Base local abstraction. Treat state files/profile dirs as credential material. |
| 2 | [Nango](https://nango.dev/docs/guides/auth/auth-guide) | OAuth/API credentials, encrypted storage, refresh. | OAuth-first account connection layer. |
| 3 | [1Password Service Accounts](https://www.1password.dev/service-accounts/get-started) plus [Fastmail Masked Email](https://support.1password.com/fastmail/) | Vault item references, credential retrieval via approved service account, stable aliases via Fastmail/JMAP. | Good human-approved credential and alias source; store refs only in Moa. |
| 4 | [Browserbase Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) | Encrypted remote browser contexts preserving cookies, localStorage, IndexedDB, sessionStorage, and preferences. | Best managed remote-browser candidate. Disable CAPTCHA solving and unnecessary recording for sensitive sessions. |
| 5 | [Auth0 Token Vault](https://auth0.com/ai/docs/intro/token-vault) | Connected external-provider access/refresh tokens under Auth0. | Strong governance if Auth0 is the chosen identity layer. |
| 6 | [MailSlurp](https://www.mailslurp.com/docs/wait-for/) and [Mailosaur](https://mailosaur.com/docs/api) | API-created inboxes, wait-for-email, code/link extraction. | Use for Chief-Moa-owned QA/staging accounts, not for external services that prohibit disposable/test inboxes. |
| 7 | [Browserless](https://docs.browserless.io/baas/session-management/persisting-state) | Browser session persistence and self-hostable/private deployment options. | Self-hosted Browserbase alternative; watch license and avoid stealth/evasion features. |
| 8 | [Arcade](https://docs.arcade.dev/home/auth/how-arcade-helps) | OAuth/API/user-token handling for agent tools. | Useful later for governed MCP tool execution. |
| 9 | [browser-use](https://github.com/browser-use/browser-use) | Local Chrome/current-tab login reuse, CDP, cloud profiles, `user_data_dir`, `storage_state`. | Good harness layer; do not depend on stealth or CAPTCHA features. |
| 10 | [SCIM RFC 7644](https://datatracker.ietf.org/doc/html/rfc7644), Okta, Entra, Keycloak, FusionAuth | Account lifecycle, user/group provisioning, ownership, revocation, audit. | Reuse the lifecycle model for personas in owned/customer-authorized tenants. |

## Recommendation

Build a provider-neutral `AccountConnection`/`Persona`/`BrowserSession` contract:

- `oauth_connection_ref`
- `vault_item_ref`
- `email_alias_ref`
- `browser_profile_ref`
- owner, tenant, allowed domains, consent receipts, rotation timestamps, risk flags
- lease state, TTL, revocation state, user-takeover requirement

Hard boundary: no CAPTCHA bypass, no stealth/proxy evasion, no fake identities, no hidden signup automation. CAPTCHA, MFA, payment, privileged OAuth consent, and external account creation stay human-approved and auditable.

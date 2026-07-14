# Connector And Agent Authentication Decision

Date: 2026-07-13

## Decision

Chief Moa will keep its capability catalog, resolution policy, proposals,
approvals, receipts, and opaque connection records as the durable product
contract. It will not build a Composio clone and it will not make any connector
vendor's tool schema the model interface.

The first production connector broker to evaluate behind
`connector-broker.js` is self-hosted Nango Auth + Proxy. Adoption is conditional
on an Elastic License 2.0 review, an external Postgres/Redis backup-and-restore
exercise, an explicit `NANGO_ENCRYPTION_KEY`, and a migration fixture proving
that Moa's opaque connection records can be rebound to another adapter. Until
those gates pass, the repository's built-in encrypted connection store remains
the only live credential path.

Better Auth is an identity/device-authorization candidate, not the integration
broker. Its OAuth 2.1 Provider may later let browser, Android, desktop, MCP, and
other public clients authenticate to Moa. Its Agent Auth plugin is explicitly
treated as experimental because that protocol is still unstable. Better Auth
must never become execution authority or the canonical capability catalog, and
OAuth token encryption must be explicitly enabled if it is adopted.

Composio remains an optional hosted adapter. Its SDK is reusable, but the
platform is not an independently self-hostable foundation. Activepieces may be
revisited for workflow/piece reuse; Pipedream is a hosted alternative, not a
self-hosted core.

## Credential Custody And Session Reuse

- Official API credentials remain gateway-side or inside the selected external
  broker. Clients and models receive only Moa-owned opaque handles.
- An already signed-in browser is a local executor candidate, not an OAuth
  connection. The extension must not export cookies, authorization headers,
  passwords, or browser storage.
- API execution is preferred for repeatable, background, bulk, and
  cross-device work. Local browser execution is preferred for current drafts,
  UI-only state, unsupported APIs, or explicitly page-local work.
- Android, macOS, and Windows consume the same observation/candidate/proposal/
  receipt contracts; they do not each get a connector framework.

## Portability And Recovery Gates

Before a live external adapter is enabled, verification must prove tenant/user
isolation, least-privilege scope display, callback replay rejection, refresh
rotation, revoke/reconnect, credential non-disclosure, exportable connection
metadata, database backup, database restore, and adapter migration. A vendor
outage must degrade the affected API candidate to unavailable without disabling
local browser or device candidates.

## Primary Sources

- Nango repository, authorization, self-hosting, and license:
  <https://github.com/NangoHQ/nango>,
  <https://nango.dev/docs/guides/auth>,
  <https://nango.dev/docs/guides/platform/self-hosting>, and
  <https://github.com/NangoHQ/nango/blob/master/LICENSE>.
- Better Auth repository, OAuth, OAuth Provider, Agent Auth, and options:
  <https://github.com/better-auth/better-auth>,
  <https://better-auth.com/docs/concepts/oauth>,
  <https://better-auth.com/docs/plugins/oauth-provider>,
  <https://better-auth.com/docs/plugins/agent-auth>, and
  <https://better-auth.com/docs/reference/options>.
- Composio and Activepieces repositories:
  <https://github.com/ComposioHQ/composio> and
  <https://github.com/activepieces/activepieces>.


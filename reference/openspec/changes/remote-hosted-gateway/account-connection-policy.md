# Account Connection And Credential Health Policy

## Purpose

Chief Moa needs a gateway-owned contract for user-connected accounts and
subscriptions such as model providers, email, calendar, repo hosts, payment
accounts, and other SaaS tools. A user may connect more than one account for the
same provider, label each connection, inspect credential health, and reauthorize
without ever placing raw provider credentials in Android or the browser
extension.

This is a product/data contract for later gateway API and store work. It does
not grant execution authority. Provider output and server output remain
proposals until the owning client, provider, or integration returns a receipt.

## Trust Boundary

- Android and the browser extension store only the gateway URL, gateway-issued
  device/session token, connection ids, display labels, status summaries, and
  short-lived user-action URLs or codes.
- Raw provider credentials, OAuth refresh tokens, API keys, PATs, service
  account material, and provider session cookies never leave the gateway-side
  credential boundary.
- The gateway stores either encrypted server-side credentials or opaque
  connection handles from a credential broker. API responses expose only
  `credential_ref_kind`, never decryptable credential values.
- The gateway may queue a user notification or reauth prompt for a target
  device, but the target client decides how to display it and records a local
  receipt if it executes a local notification action.
- Connected accounts are scoped to an authenticated better-auth user. Hosted
  mode must not allow one user to list, refresh, or reauthorize another user's
  connections.
- This policy excludes account-creation, subscription-limit evasion, scraping
  of provider account pages, or any automation intended to bypass a provider's
  plan limits or terms.

## Product Primitive

`account_connection`: a gateway-owned record linking one authenticated Moa user
to one provider account, subscription, organization, or workspace.

A user may have multiple `account_connection` records with the same `provider`
when the labels, provider subjects, subscriptions, scopes, or credential kinds
are different.

## Provider Catalog Contract

`GET /v1/account-providers` returns the provider catalog the gateway supports.

Provider fields:

```json
{
  "id": "openai",
  "label": "OpenAI",
  "credential_kinds": ["oauth2_authorization_code", "api_key"],
  "supports_refresh": true,
  "supports_manual_reauth": true,
  "supports_multiple_connections": true,
  "scopes": ["models.read", "responses.write"],
  "docs_url": "https://provider.example/account"
}
```

Provider ids are stable product ids, not display strings. Provider labels are
for UI only.

## Account Connection Data Contract

`GET /v1/account-connections` returns summaries. `GET
/v1/account-connections/{connection_id}` returns one summary plus non-secret
diagnostics. Neither response returns raw credentials.

Canonical fields:

```json
{
  "id": "acctconn_...",
  "user_id": "usr_...",
  "provider": "openai",
  "provider_label": "OpenAI",
  "label": "Work OpenAI",
  "account_subject": {
    "display": "nat@example.com",
    "provider_account_id": "acct_123",
    "subscription_id": "sub_123",
    "organization_id": "org_123"
  },
  "credential_kind": "oauth2_authorization_code",
  "credential_ref_kind": "encrypted_server_secret",
  "status": "connected",
  "status_reason": "",
  "expires_at": "2026-07-20T17:00:00.000Z",
  "scopes_granted": ["models.read", "responses.write"],
  "refresh": {
    "supported": true,
    "state": "idle",
    "last_attempt_at": "",
    "last_success_at": "2026-07-03T15:00:00.000Z",
    "next_attempt_at": "2026-07-20T16:45:00.000Z",
    "failure_code": "",
    "failure_message": "",
    "attempt_count": 0
  },
  "needs_user_action": false,
  "user_action": null,
  "device_notification_target": {
    "device_id": "android_primary",
    "surface_type": "android",
    "channel": "credential_health",
    "enabled": true
  },
  "audit": {
    "created_at": "2026-07-03T14:00:00.000Z",
    "updated_at": "2026-07-03T15:00:00.000Z",
    "status_changed_at": "2026-07-03T15:00:00.000Z",
    "last_health_check_at": "2026-07-03T15:00:00.000Z",
    "last_used_at": "",
    "created_by": { "kind": "user", "id": "usr_..." },
    "updated_by": { "kind": "gateway", "id": "credential-health" }
  }
}
```

`credential_kind` values:

- `oauth2_authorization_code`: OAuth authorization-code flow with a refresh
  token when the provider grants one.
- `oauth2_device_code`: OAuth device-code flow where the gateway returns a
  verification URI and user code.
- `api_key`: user enters a provider key into a gateway-served form; the gateway
  encrypts and stores it server-side.
- `personal_access_token`: user enters a PAT into a gateway-served form; the
  gateway encrypts and stores it server-side.
- `service_account`: user uploads or pastes service-account material into a
  gateway-served form; the gateway encrypts and stores it server-side.
- `external_handle`: a credential broker or provider vault owns the secret; the
  gateway stores only an opaque handle.
- `none`: provider connection has no reusable credential and always requires a
  fresh user action.

`credential_ref_kind` values:

- `encrypted_server_secret`
- `opaque_broker_handle`
- `provider_managed_session`
- `none`

`status` values:

- `pending_user_auth`: connection was started and waits for provider/user
  authorization.
- `connected`: credential is usable.
- `refreshing`: gateway is attempting provider-supported refresh.
- `action_required`: user reauthorization, secret rotation, scope approval, or
  provider portal action is needed.
- `expired`: the credential reached `expires_at` and cannot be used until
  refreshed or reauthorized.
- `invalid`: provider rejected the credential.
- `disabled`: user disabled the connection without deleting audit history.
- `revoked`: user or provider revoked the connection.
- `error`: gateway could not determine health; retry or user inspection needed.

`refresh.state` values:

- `not_supported`
- `idle`
- `scheduled`
- `refreshing`
- `succeeded`
- `failed`
- `blocked`

When `needs_user_action` is true, `user_action` contains only non-secret
instructions and a reauth endpoint:

```json
{
  "reason": "refresh_token_expired",
  "message": "OpenAI needs you to sign in again.",
  "since": "2026-07-03T16:00:00.000Z",
  "reauth_endpoint": "/v1/account-connections/acctconn_123/reauth",
  "action_type": "open_url",
  "expires_at": ""
}
```

## Gateway API Contract

Provider/catalog:

- `GET /v1/account-providers`

Connection CRUD and health:

- `GET /v1/account-connections`
- `GET /v1/account-connections/{connection_id}`
- `POST /v1/account-connections`
- `PATCH /v1/account-connections/{connection_id}`
- `POST /v1/account-connections/{connection_id}/disable`
- `POST /v1/account-connections/{connection_id}/disconnect`
- `POST /v1/account-connections/{connection_id}/refresh`
- `POST /v1/account-connections/{connection_id}/reauth`
- `GET /v1/account-connections/oauth/callback`

`POST /v1/account-connections` starts a connection. It accepts `provider`,
`label`, `credential_kind`, optional `scopes`, optional
`device_notification_target`, and an optional `return_url`. It returns one of:

- a `connection` summary with `status=connected` when no provider round trip is
  needed;
- `202` plus a `reauth_action` when the user must complete OAuth, device-code,
  or manual secret entry.

`PATCH /v1/account-connections/{connection_id}` may update `label`,
`device_notification_target`, and disabled/enabled display preferences. It must
not accept raw credential fields.

`POST /v1/account-connections/{connection_id}/refresh` asks the gateway to run
provider-supported refresh now. It returns `202` with `refresh.state=scheduled`
or `refreshing`, or `409` with `needs_user_action=true` when refresh is not
possible without the user.

`POST /v1/account-connections/{connection_id}/reauth` creates a short-lived
reauth action. The returned URL/code is a prompt, not a stored credential.

OAuth callbacks are gateway-only. Android and the browser can open the URL, but
the provider redirects back to the gateway, and the gateway stores the resulting
credential server-side.

## Reauth Action Contract

`POST /v1/account-connections/{connection_id}/reauth` returns:

```json
{
  "connection_id": "acctconn_123",
  "provider": "openai",
  "reauth_action": {
    "type": "open_url",
    "url": "https://gateway.example/v1/account-connections/oauth/start?...",
    "expires_at": "2026-07-03T16:10:00.000Z",
    "message": "Sign in to OpenAI again."
  }
}
```

Allowed `reauth_action.type` values:

- `open_url`: client opens a gateway/provider URL.
- `enter_device_code`: client shows `verification_uri`, `user_code`, and
  `expires_at`; the gateway polls provider token state server-side.
- `gateway_secret_form`: client opens a gateway-served form where the user
  enters a new API key, PAT, or service-account material.
- `provider_portal`: client opens provider account settings when the provider
  requires subscription or billing action rather than credential refresh.

Manual reauth is always available for credential kinds where the user can rotate
the credential. Provider-supported refresh is used first when it is safe and
available; manual reauth is the fallback when refresh fails, is unsupported, or
requires new scopes.

## Refresh And Health Policy

The gateway owns credential health checks. A later implementation should run
health checks:

- when a connection is created;
- before a credential is used;
- shortly before `expires_at`;
- after provider errors such as invalid token, insufficient scope, subscription
  inactive, or billing required;
- when the user requests refresh or reauth.

Provider-supported refresh path:

```text
connection connected
  -> scheduler sees expires_at approaching
  -> gateway marks refresh.state=refreshing and emits account.connection.refresh.started
  -> provider refresh succeeds
  -> gateway replaces encrypted credential material or opaque handle server-side
  -> gateway marks status=connected, updates expires_at and refresh.next_attempt_at
  -> gateway emits account.connection.refresh.succeeded
```

Manual reauth path:

```text
health check or refresh fails
  -> gateway marks status=action_required or expired
  -> gateway sets needs_user_action=true
  -> gateway emits account.connection.user_action_requested
  -> gateway optionally queues a device notification target through /v1/tool/requests
  -> user opens the reauth action
  -> provider/gateway returns a fresh credential or opaque handle
  -> gateway stores it server-side and emits account.connection.reauth.completed
```

Failed refresh must not delete the last known credential immediately. The
connection moves to `action_required`, `expired`, `invalid`, or `error` based on
provider evidence, and audit events preserve the transition.

## Device Notification Target

`device_notification_target` tells the gateway where to nudge the user when a
credential needs attention. It is not authority to execute provider actions.

The target references the existing device-client hub:

```json
{
  "device_id": "android_primary",
  "surface_type": "android",
  "channel": "credential_health",
  "enabled": true
}
```

When `needs_user_action=true`, the gateway SHOULD:

1. emit `account.connection.user_action_requested`;
2. if the target is enabled and online, queue `/v1/tool/requests` with a
   notification-capable tool such as `notification.account_connection`;
3. include only `connection_id`, provider label, account label, reason, and
   `reauth_endpoint` in the tool input;
4. record `account.connection.notification.queued` or
   `account.connection.notification.skipped`.

If no target is available, the connection list remains the source of truth and
the event log records the skipped notification.

## Audit Events

Every status-changing operation emits a product event in the event substrate.
The canonical stream id is `account-connection:{connection_id}`. The event actor
is the authenticated user, gateway, provider adapter, device, or system job that
caused the transition.

Required event types:

- `account.connection.created`
- `account.connection.auth.started`
- `account.connection.auth.completed`
- `account.connection.secret.stored`
- `account.connection.secret.rotated`
- `account.connection.health.checked`
- `account.connection.refresh.started`
- `account.connection.refresh.succeeded`
- `account.connection.refresh.failed`
- `account.connection.status.changed`
- `account.connection.user_action_requested`
- `account.connection.notification.queued`
- `account.connection.notification.skipped`
- `account.connection.reauth.started`
- `account.connection.reauth.completed`
- `account.connection.disabled`
- `account.connection.disconnected`
- `account.connection.revoked`

Event payloads may include provider id, connection id, label, credential kind,
old/new status, refresh state, non-secret provider error codes, expiry times,
device notification target, and correlation ids. Event payloads must not include
raw credential values, provider refresh tokens, API keys, PATs, service-account
material, or provider cookies.

## Store Contract For Later Implementation

The gateway should persist account connections in Postgres in remote modes and
may keep a local JSON/JSONL projection for local mode while the early gateway
still has file fallback support.

At minimum the store needs:

- `account_connections`: current projection keyed by `id`, `user_id`, and
  `provider`.
- `account_connection_credentials`: encrypted server-side secret refs or opaque
  broker handles, never returned through normal API serializers.
- `account_connection_events`: optional optimized projection; canonical audit
  still mirrors to `product_events`.
- a uniqueness/indexing strategy that supports multiple connections per
  provider while preventing duplicate provider subjects when the provider gives
  stable account ids.

Encryption details are implementation tickets, but the API contract already
requires secret-at-rest protection and serializers that cannot leak secret
fields.

## Acceptance Checks

- The contract names list/detail/create/update/refresh/reauth/disconnect
  endpoints.
- The contract names `provider`, `label`, `credential_kind`, `status`,
  `expires_at`, `refresh`, `needs_user_action`,
  `device_notification_target`, audit events, and reauth action fields.
- The contract has both provider-supported refresh and manual reauth paths.
- The contract states that Android/browser never receive raw provider
  credentials and that gateway storage uses encrypted credentials or opaque
  handles only.
- The contract can be implemented as gateway API/store tickets without changing
  the Android/browser trust boundary.

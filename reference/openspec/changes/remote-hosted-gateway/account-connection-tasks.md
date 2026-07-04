# Account Connection And Credential Health Tasks

These tickets turn `account-connection-policy.md` into later gateway API and
store work. They are scoped to the remote-hosted gateway change and should land
after the better-auth user/device-token base exists.

## Ticket 1: Provider Catalog

Track: backend

Files:

- `gateway/server.js`
- `gateway/lib/account-providers.js`
- `gateway/test` or existing gateway smoke scripts

Implement:

- Add a gateway provider catalog with stable provider ids, display labels,
  supported credential kinds, refresh support, manual reauth support, allowed
  scopes, and docs URLs.
- Add `GET /v1/account-providers`.
- Require auth in remote modes; local mode may follow the existing token
  fallback until better-auth is enabled.

Acceptance:

- `GET /v1/account-providers` returns at least one provider fixture with
  `id`, `label`, `credential_kinds`, `supports_refresh`, and
  `supports_manual_reauth`.
- The endpoint does not expose any secret env values.
- The response is user-independent catalog data and can be cached by clients.

Verification:

- `cd gateway && npm run check`
- Gateway smoke: authenticated `GET /v1/account-providers` returns `200`.

## Ticket 2: Account Connection Store And Serializers

Track: backend

Files:

- `gateway/schema.sql`
- `gateway/lib/account-connections.js`
- `gateway/lib/event-substrate.js` only if event helpers need extension
- local file fallback under `DATA_DIR` only if needed for `MOA_MODE=local`

Implement:

- Add the current-state projection for `account_connections`.
- Add a credential storage boundary that stores only encrypted server-side
  credential refs or opaque broker handles in normal records.
- Add serializers for list/detail responses that include non-secret fields from
  the policy and cannot return raw credential material.
- Scope every query by authenticated `user_id`.

Acceptance:

- Store records support multiple connections per provider for one user.
- List/detail serializers include `provider`, `label`, `credential_kind`,
  `status`, `expires_at`, `refresh`, `needs_user_action`,
  `device_notification_target`, and `audit`.
- Serializers expose `credential_ref_kind` but never credential values,
  refresh tokens, API keys, PATs, service-account material, or provider cookies.
- Hosted/self-host modes use Postgres; local mode can use the file fallback only
  as a development projection.

Verification:

- `cd gateway && npm run check`
- Store unit or smoke creates two same-provider connections for one user and
  verifies both serialize without secret fields.

## Ticket 3: Connection List, Detail, Label, And Notification Target API

Track: backend

Files:

- `gateway/server.js`
- `gateway/lib/account-connections.js`
- gateway smoke script

Implement:

- Add `GET /v1/account-connections`.
- Add `GET /v1/account-connections/{connection_id}`.
- Add `PATCH /v1/account-connections/{connection_id}` for `label` and
  `device_notification_target`.
- Reject raw credential fields on `PATCH`.

Acceptance:

- A user can list only their own connections.
- Detail returns one non-secret connection summary.
- Label updates are audited and visible on the next list/detail read.
- `device_notification_target` can point at an existing `device_client` by
  `device_id`, `surface_type`, `channel=credential_health`, and `enabled`.
- Attempts to patch `credential`, `api_key`, `refresh_token`, `password`, or
  similarly named secret fields fail with `400`.

Verification:

- `cd gateway && npm run check`
- Endpoint smoke covers list/detail/patch and a rejected secret-field patch.

## Ticket 4: Connection Start, OAuth Callback, And Manual Secret Entry

Track: backend

Files:

- `gateway/server.js`
- `gateway/lib/account-connections.js`
- provider adapter module for OAuth/manual credential flows
- gateway-served secret entry route or minimal form

Implement:

- Add `POST /v1/account-connections`.
- Add `GET /v1/account-connections/oauth/callback`.
- For OAuth providers, return a short-lived `reauth_action.type=open_url` or
  `enter_device_code` action and store callback results gateway-side.
- For manual credentials, return `reauth_action.type=gateway_secret_form`; the
  form posts directly to the gateway and stores encrypted credential material
  server-side.
- Emit `account.connection.created`, `account.connection.auth.started`,
  `account.connection.auth.completed`, and `account.connection.secret.stored`.

Acceptance:

- Starting an OAuth connection creates a pending connection and returns a
  short-lived action without exposing provider tokens to Android/browser.
- Completing the callback stores a server-side credential ref, marks the
  connection `connected`, and records `expires_at` when available.
- Starting a manual credential connection opens only a gateway-hosted secret
  form; Android/browser never receive the submitted secret after form post.
- All created connections are scoped to the authenticated user.

Verification:

- `cd gateway && npm run check`
- OAuth fixture smoke completes a fake callback and confirms the serialized
  connection has `credential_ref_kind` but no secret value.
- Manual fixture smoke posts a fake secret to the gateway form and confirms the
  list/detail response is non-secret.

## Ticket 5: Credential Health, Refresh Scheduler, And Explicit Refresh API

Track: backend

Files:

- `gateway/server.js`
- `gateway/lib/account-connections.js`
- provider adapter module
- gateway smoke script

Implement:

- Add health-check helpers that can run on create, before use, before expiry,
  after provider errors, and on demand.
- Add `POST /v1/account-connections/{connection_id}/refresh`.
- Add a scheduler or queue hook that marks refresh state and attempts
  provider-supported refresh before `expires_at`.
- Store refresh state fields: `supported`, `state`, `last_attempt_at`,
  `last_success_at`, `next_attempt_at`, `failure_code`, `failure_message`, and
  `attempt_count`.
- Emit `account.connection.health.checked`,
  `account.connection.refresh.started`,
  `account.connection.refresh.succeeded`, `account.connection.refresh.failed`,
  and `account.connection.status.changed`.

Acceptance:

- A refresh-capable provider moves through `scheduled` or `refreshing` back to
  `connected` and updates `expires_at`.
- A provider that does not support refresh returns `409` from explicit refresh,
  sets `needs_user_action=true`, and leaves raw credentials hidden.
- Failed refresh preserves audit history and moves the connection to
  `action_required`, `expired`, `invalid`, or `error` based on provider
  evidence.

Verification:

- `cd gateway && npm run check`
- Fixture smoke proves success, unsupported refresh, and failed refresh state
  transitions.

## Ticket 6: Manual Reauth Actions And Device Notifications

Track: backend

Files:

- `gateway/server.js`
- `gateway/lib/account-connections.js`
- `gateway/lib/tool-requests` or existing tool-request helpers in
  `gateway/server.js`
- gateway smoke script

Implement:

- Add `POST /v1/account-connections/{connection_id}/reauth`.
- Return only short-lived non-secret actions: `open_url`,
  `enter_device_code`, `gateway_secret_form`, or `provider_portal`.
- When `needs_user_action=true`, use `device_notification_target` to queue a
  `/v1/tool/requests` notification if a matching online device advertises a
  notification-capable tool.
- Emit `account.connection.user_action_requested`,
  `account.connection.notification.queued`,
  `account.connection.notification.skipped`,
  `account.connection.reauth.started`, and
  `account.connection.reauth.completed`.

Acceptance:

- Manual reauth returns a provider-appropriate action with `connection_id`,
  provider label, account label, message, and expiry, but no raw credential.
- Offline or missing device targets do not block reauth; they record a skipped
  notification event and leave the connection visible in list/detail.
- Online device targets get a tool request whose input contains only
  `connection_id`, provider label, account label, reason, and
  `reauth_endpoint`.
- Successful reauth clears `needs_user_action`, updates `status`, and records
  audit events.

Verification:

- `cd gateway && npm run check`
- Endpoint smoke covers reauth action generation, queued notification for an
  online device, skipped notification for an offline target, and a successful
  fake reauth completion.

## Ticket 7: Disable, Disconnect, And Revocation Audit

Track: backend

Files:

- `gateway/server.js`
- `gateway/lib/account-connections.js`
- provider adapter module
- gateway smoke script

Implement:

- Add `POST /v1/account-connections/{connection_id}/disable`.
- Add `POST /v1/account-connections/{connection_id}/disconnect`.
- Disable keeps the record and audit history but prevents use.
- Disconnect revokes provider credentials when the provider supports revocation,
  deletes or retires server-side credential refs, and keeps non-secret audit.
- Emit `account.connection.disabled`, `account.connection.disconnected`,
  `account.connection.revoked`, and `account.connection.status.changed`.

Acceptance:

- Disabled connections remain listed with `status=disabled`.
- Disconnected connections cannot be used for provider calls and do not retain
  active credential refs.
- Provider revocation failures are captured as non-secret audit evidence and do
  not leak credentials.

Verification:

- `cd gateway && npm run check`
- Endpoint smoke disables and disconnects a fixture connection and verifies
  status, credential ref retirement, and event emission.

## Ticket 8: Artifact-Level Acceptance For This Contract

Track: docs

Files:

- `reference/openspec/changes/remote-hosted-gateway/account-connection-policy.md`
- `reference/openspec/changes/remote-hosted-gateway/account-connection-tasks.md`

Acceptance:

- The policy names endpoints, data fields, refresh paths, manual reauth paths,
  device notification target behavior, and audit event types.
- The tasks split implementation into gateway API/store tickets with concrete
  acceptance checks.
- The trust boundary explicitly keeps raw provider credentials out of
  Android/browser.

Verification:

- Artifact review of both files.
- `fabro validate .fabro/workflows/vps-agent-control-plane/workflow.fabro`

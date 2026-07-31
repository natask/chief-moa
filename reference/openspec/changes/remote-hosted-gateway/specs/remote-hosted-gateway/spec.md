## ADDED Requirements

### Requirement: One Image, Env-Driven Modes

The gateway SHALL ship as one deployable image whose deployment mode is selected
by env, with no separate hosted and self-host builds.

#### Scenario: Local mode

- **WHEN** the gateway starts with `MOA_MODE=local`
- **THEN** it may run without auth, may use the file fallback store, and binds a
  loopback interface by default

#### Scenario: Remote mode

- **WHEN** the gateway starts with `MOA_MODE=self-host` or `MOA_MODE=hosted`
- **THEN** it requires a configured auth path and `DATABASE_URL`, binds
  `0.0.0.0`, and trusts the proxy for forwarded client protocol and IP
- **AND** refuses to start if `DATABASE_URL` is missing

### Requirement: Per-User Auth Through Better-auth

The gateway SHALL progress from the single `MOA_GATEWAY_TOKEN` to better-auth
issuing per-user sessions and per-device tokens, without changing what the client
stores.

#### Scenario: Auth flag off

- **WHEN** better-auth is not enabled
- **THEN** the single `MOA_GATEWAY_TOKEN` still authenticates protected routes

#### Scenario: Token maps to an owner user

- **WHEN** better-auth is enabled
- **THEN** the existing single token maps to a seeded owner user so events
  recorded before auth keep one stable author

#### Scenario: User signs in

- **WHEN** a user signs in with email or passkey
- **THEN** the gateway issues a per-user session for the gateway-served UI

### Requirement: Device Registration

A device SHALL turn its bootstrap token into a per-device token bound to a user
without holding provider keys or account passwords.

#### Scenario: Device registered

- **WHEN** a user approves a device against their account
- **THEN** the gateway mints a per-device token bound to the user id and device id
- **AND** the device keeps calling the same endpoints with only a gateway URL and
  that token

#### Scenario: Tokenless Android app bootstraps through OTA

- **WHEN** an installed Android app has no gateway bearer token during the
  transition to device registration
- **THEN** it may read only the current OTA manifest and current APK without
  authentication on its configured application channel
- **AND** version-pinned APK reads, rollback, and every non-OTA gateway route
  remain authenticated

### Requirement: User-Scoped Voice Ticket

The voice WebSocket ticket flow SHALL stay one-use and become user-scoped.

#### Scenario: Ticket minted

- **WHEN** an authenticated session or a valid device token requests a voice
  ticket
- **THEN** the gateway mints a one-use ticket carrying the user id for the voice
  session

#### Scenario: Ticket denied

- **WHEN** a voice ticket is requested without an authenticated session or valid
  device token in a remote mode
- **THEN** the gateway refuses to mint a ticket

### Requirement: Postgres Required For Remote Modes

Remote deployments SHALL use Postgres, while local dev MAY keep the file
fallback.

#### Scenario: Remote store

- **WHEN** the gateway runs in `self-host` or `hosted` mode
- **THEN** it uses `DATABASE_URL` Postgres for auth tables and the event store

#### Scenario: Local store

- **WHEN** the gateway runs in `local` mode without a database
- **THEN** it uses the JSON/JSONL fallback

### Requirement: Blobs On Persistent Storage

`DATA_DIR` blobs SHALL survive container rebuilds on the VPS.

#### Scenario: Container rebuilt

- **WHEN** the gateway container is rebuilt on the VPS
- **THEN** OTA artifacts and retained voice audio under `DATA_DIR` remain because
  `DATA_DIR` maps to a persistent volume

### Requirement: Harness Stays Off The VPS Via Worker Pull

The remote gateway SHALL queue agent runs, and the execution machine SHALL claim
them by connecting outbound, so no inbound port opens on the user's machine.

#### Scenario: Run claimed outbound

- **WHEN** a run is queued on the gateway
- **THEN** an execution machine that only connects outbound claims the run, runs
  the named harness locally, and reports status and result back to the gateway

#### Scenario: Gateway does not execute

- **WHEN** a run is on the gateway
- **THEN** the gateway records lifecycle but never runs the harness itself, and
  harness output stays a proposal

#### Scenario: Worker token scope

- **WHEN** an execution machine authenticates to claim runs
- **THEN** it uses a worker token that authorizes only run claim and report,
  distinct from device tokens

### Requirement: Cloudflare Split

The static frontend SHALL run on Cloudflare Pages while the gateway API and voice
WebSocket run on the VPS behind proxied Cloudflare DNS.

#### Scenario: Frontend served

- **WHEN** a user loads the marketing or app-shell frontend
- **THEN** Cloudflare Pages serves it

#### Scenario: API and voice served

- **WHEN** a client calls the gateway API or opens the voice WebSocket
- **THEN** a proxied Cloudflare DNS record forwards to the VPS gateway, and the
  gateway does not run inside Cloudflare Workers

### Requirement: Single Sticky Voice Instance

Voice SHALL run as one sticky instance until scaling is designed.

#### Scenario: One instance

- **WHEN** voice is deployed
- **THEN** it runs as a single instance holding its own sessions, and
  multi-instance voice scaling is out of scope

### Requirement: Observable Deployment Identity

The gateway SHALL report a non-sensitive immutable build identity through
`GET /health` without reading Git state while handling a request.

#### Scenario: Image metadata is injected

- **WHEN** the deployment builds a gateway image from a reviewed Git ref
- **THEN** health reports the validated full Git SHA, deployment ref, and UTC
  build time embedded in that image

#### Scenario: Build metadata is unavailable

- **WHEN** the gateway starts without injected build metadata
- **THEN** health reports `unknown` values with the same stable response shape

#### Scenario: Build metadata is malformed

- **WHEN** an injected build metadata value does not match its constrained
  public format
- **THEN** health reports `unknown` for that value instead of returning
  arbitrary environment content

### Requirement: Backup Before Promotion

Any promotion that changes the active URL or restarts the active service SHALL
run a backup and a read-only restore check first.

#### Scenario: Promotion guarded

- **WHEN** an operator promotes a change to the active deployment
- **THEN** a Postgres dump and a `DATA_DIR` snapshot are taken and a read-only
  restore check passes against a scratch target before the active URL changes or
  the active service restarts

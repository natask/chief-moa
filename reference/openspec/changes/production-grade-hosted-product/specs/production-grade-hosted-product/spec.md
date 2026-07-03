## ADDED Requirements

### Requirement: Postgres Is The Source Of Truth In Remote Modes

In `self-host` and `hosted` modes the gateway SHALL read durable product state
from Postgres projections over the event log, not from flat files. The flat-file
store SHALL remain only as the `local` mode fallback and as a one-time migration
source.

#### Scenario: Remote read from Postgres

- **WHEN** the gateway runs in `self-host` or `hosted` mode and serves a
  sessions, voice-turn, agent-run, browser-task, tool-request, or profile read
- **THEN** it answers from a Postgres projection, not from a `DATA_DIR` file

#### Scenario: Local fallback preserved

- **WHEN** the gateway runs in `local` mode without `DATABASE_URL`
- **THEN** it still serves reads from the flat-file store

#### Scenario: One-time migration from files

- **WHEN** an operator runs the file-import migration against an existing
  `DATA_DIR`
- **THEN** existing conversations, voice turns, runs, browser tasks, tool
  requests, and profile history are appended into `product_events` and become
  readable through the projections, and re-running the import does not duplicate
  events

### Requirement: Anonymous-First Accounts

The gateway SHALL let a first-time client use the product under an anonymous
session, and SHALL require account creation to continue past a configured trial
boundary, linking the anonymous session's data to the new account.

#### Scenario: Anonymous use on first visit

- **WHEN** a new client with no account connects in a mode where auth is enabled
- **THEN** the gateway issues an anonymous session bound to a real user id and
  the client can use the product without signing up

#### Scenario: Trial boundary requires an account

- **WHEN** an anonymous session crosses the configured trial boundary
- **THEN** the gateway requires account creation before serving further
  billable turns, and the trial counter is server-side so clearing client
  storage does not reset it

#### Scenario: Account creation links prior data

- **WHEN** an anonymous user creates an account
- **THEN** the events, connections, and keys created under the anonymous session
  are attributed to the new account id without loss

#### Scenario: Local mode may disable auth

- **WHEN** the gateway runs in `local` mode
- **THEN** the anonymous boundary and account requirement may be disabled entirely

### Requirement: Per-Device Login For Clients

The gateway SHALL let the browser extension and Android authenticate a user and
receive a per-device token, without the client storing anything beyond a gateway
URL and that token.

#### Scenario: Extension login

- **WHEN** a user signs in from the extension and approves the device
- **THEN** the gateway mints a per-device token bound to the user id and device
  id, and the extension stores only the gateway URL and that token

#### Scenario: Client holds no secrets

- **WHEN** any client is provisioned with a device token
- **THEN** it holds no provider API keys, no account password, and no raw BYOK
  secret

### Requirement: Per-User Virtual Keys For Model Access

The gateway SHALL represent each user's model access as one or more virtual keys,
each carrying an allowed model set, a routing policy, and a spend/budget counter.

#### Scenario: BYOK routing

- **WHEN** a virtual key has policy `byok` and the user has stored a provider key
- **THEN** the gateway decrypts that key at call time, uses it for the provider
  request, and never returns it, logs it, or places it in model-visible context

#### Scenario: Hosted-pool routing

- **WHEN** a virtual key has policy `hosted_pool`
- **THEN** the gateway uses the hosted product's own provider credentials and
  applies the user's plan metering and budget

#### Scenario: Self-host operator routing

- **WHEN** the gateway runs self-hosted with an operator provider key configured
- **THEN** virtual keys with policy `self_host_operator` route to that single
  operator key

#### Scenario: Over-budget key refused

- **WHEN** a virtual key's projected spend is at or over its budget
- **THEN** the gateway refuses the call before contacting the provider and
  reports the budget state

### Requirement: Encrypted BYOK Key Storage

Stored BYOK provider keys SHALL be encrypted at rest with envelope encryption and
SHALL never be returned to a client. An external vault backend MAY replace the
built-in store without changing the calling interface.

#### Scenario: Key stored encrypted

- **WHEN** a user submits a BYOK provider key
- **THEN** the gateway wraps it with a per-key data key sealed by the deployment
  master key and stores only the ciphertext and wrapped data key in Postgres

#### Scenario: Master key never in the database

- **WHEN** the gateway persists an encrypted key
- **THEN** the deployment master key is read from env only and is never written
  to the database

#### Scenario: External vault backend

- **WHEN** an operator configures an external vault backend (e.g. Nango or
  Infisical)
- **THEN** the key store delegates put/get/rotate/revoke to that backend through
  the same interface, with no change to callers

### Requirement: Metering And Billing Seam

The gateway SHALL emit a metering event for each model call and SHALL check a
virtual key's budget before the call, behind a pluggable billing-provider
interface. Live charging is out of scope for this change.

#### Scenario: Usage metered

- **WHEN** the gateway completes a model call for a virtual key
- **THEN** it emits a `usage_metered` product event carrying the user id, virtual
  key, model, token counts, and cost estimate, and the key's spend projection
  reflects it

#### Scenario: Billing provider is pluggable

- **WHEN** no billing provider is configured
- **THEN** the gateway meters for visibility but does not charge, and a
  configured provider implements ensureCustomer, reportUsage, checkEntitlement,
  and webhook behind the seam

### Requirement: Agent-Driven Self-Host Provisioning

The gateway SHALL expose self-host provisioning as a claimable worker capability
that stands up a self-hosted gateway of the same image, applies the user's
customizations, and returns a new engine URL and device token, with human
approval before the active client re-points.

#### Scenario: Provisioning requested by voice or text

- **WHEN** a user asks the agent to configure and self-host the product
- **THEN** the gateway creates an agent run targeting the provisioning tool and
  returns a run id without blocking

#### Scenario: Worker runs provisioning locally

- **WHEN** the execution machine claims the provisioning run
- **THEN** it runs the VPS bootstrap, applies the customization pack, and runs a
  backup plus restore check before any active-URL cutover, all inside its local
  execution boundary with no inbound port on it and no shell handed to the gateway

#### Scenario: Human-approved re-point

- **WHEN** provisioning completes and reports a new engine URL and device token
- **THEN** the client re-points to the new self-hosted gateway only after explicit
  human approval, and the old deployment is left intact until then

### Requirement: Self-Hostable Auth Pipeline

The account, session, and device-token pipeline SHALL run inside the one gateway
image with no external identity provider required, so a self-hoster gets working
auth from the same image the hosted product runs.

#### Scenario: Self-host auth with no extra service

- **WHEN** a self-hoster runs the gateway image with auth enabled and a
  `DATABASE_URL`
- **THEN** anonymous sessions, account creation, sign-in, and per-device tokens
  all work with no separate auth service deployed

## ADDED Requirements

### Requirement: Effective profile layered over env default
The gateway SHALL treat the `SYSTEM_PROMPT` env value as the immutable default
and compute an effective profile as the persisted profile when present, else the
env default. The effective profile SHALL include at least `system_prompt` and
`model` plus a minimal behavior field set.

#### Scenario: No override falls back to default
- **WHEN** no profile has been persisted
- **THEN** the effective profile equals the env default and behavior is unchanged

#### Scenario: Persisted profile survives restart
- **WHEN** a profile has been persisted and the gateway restarts
- **THEN** the effective profile on boot equals the persisted profile

### Requirement: Profile applied per request
The gateway SHALL read the effective profile per request when building model
calls for `/v1/chat` and `/v1/voice/turns`.

#### Scenario: Updated profile affects next turn
- **WHEN** the effective profile changes and a new `/v1/voice/turns` request arrives
- **THEN** that request uses the updated profile with no process restart

### Requirement: Profile read, update, and reset endpoints
The gateway SHALL expose token-guarded endpoints to read, update (patch and
persist), and reset the effective profile.

#### Scenario: Read effective profile
- **WHEN** a client calls `GET /v1/agent/profile` with a valid token
- **THEN** the response includes the effective profile and whether it differs from the env default

#### Scenario: Update persists and applies
- **WHEN** a client calls `PUT /v1/agent/profile` with patched fields and a valid token
- **THEN** the fields are persisted and applied to subsequent turns without a restart

#### Scenario: Reset restores default
- **WHEN** a client calls `POST /v1/agent/profile/reset` with a valid token
- **THEN** persisted overrides are dropped and the effective profile returns to the env default

#### Scenario: Unauthorized access rejected
- **WHEN** a profile endpoint is called without a valid bearer token
- **THEN** the request is rejected consistent with other `/v1/agent/*` routes

### Requirement: Per-request profile override
The gateway SHALL accept a `profile_overrides` field on `/v1/chat` and
`/v1/voice/turns` that merges for that request only and SHALL NOT persist it.

#### Scenario: Ephemeral override
- **WHEN** a request includes `profile_overrides`
- **THEN** the merged profile applies to that request only and the persisted profile is unchanged

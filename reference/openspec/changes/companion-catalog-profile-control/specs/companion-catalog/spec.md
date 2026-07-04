## ADDED Requirements

### Requirement: Gateway-owned companion manifests
The gateway SHALL expose token-guarded companion manifests whose entries compile
to runtime agent profile patches. A companion SHALL include id, version, name,
summary, source, tags, appearance hints, voice, starter prompts, smoke prompts,
and a profile patch.

#### Scenario: Client lists companions
- **WHEN** a client calls `GET /v1/agent/companions` with a valid token
- **THEN** the response includes built-in companions and persisted custom
  companions
- **AND** no provider credentials or privileged extension code are returned

#### Scenario: Client searches companions
- **WHEN** a client calls `GET /v1/agent/companions?q=research`
- **THEN** only matching companion entries are returned

### Requirement: Companion draft from natural language
The gateway SHALL let a client draft a custom companion from a natural-language
request without requiring the client to write raw profile fields.

#### Scenario: Draft custom companion
- **WHEN** a client calls `POST /v1/agent/companions` with text such as
  "I want you to be a research scout"
- **THEN** the gateway persists a custom companion manifest with a safe profile
  patch
- **AND** the active runtime profile is unchanged

### Requirement: Companion preview is non-mutating
The gateway SHALL provide a companion preview that returns the compiled profile
patch and sample metadata without mutating the active runtime profile.

#### Scenario: Preview companion
- **WHEN** a client calls `POST /v1/agent/companions/preview`
- **THEN** the response includes the companion and compiled profile overrides
- **AND** `GET /v1/agent/profile` still returns the previous profile version

### Requirement: Companion apply updates runtime profile
The gateway SHALL apply a companion by patching the runtime agent profile through
the existing versioned profile store.

#### Scenario: Apply companion globally
- **WHEN** a client calls `POST /v1/agent/companions/apply` with a companion id
  and global scope
- **THEN** the runtime profile changes on the next turn
- **AND** profile history records the companion application

#### Scenario: Device-scoped apply requires device id
- **WHEN** a client applies a companion with device scope and no device id
- **THEN** the gateway rejects the request without changing the global profile

### Requirement: Spoken companion profile control
The gateway SHALL classify spoken requests to become or act as a companion as
profile control and SHALL create/apply a companion through the same catalog path.

#### Scenario: Voice creates and applies companion
- **WHEN** the user says "I want you to be a research scout"
- **THEN** `/v1/voice/turns` returns `classification=profile_control`
- **AND** the response includes a companion action and updated profile status

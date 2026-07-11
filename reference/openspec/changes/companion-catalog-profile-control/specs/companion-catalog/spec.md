## ADDED Requirements

### Requirement: Portable companion packages fail closed
The gateway package boundary SHALL accept only canonical
`moa-companion-package/v1` envelopes containing a signed manifest and bounded
declared asset bodies. Verification SHALL require caller-owned signer trust,
license acceptance, moderation-policy acceptance, compatibility and revocation
policy. A signature SHALL NOT by itself confer publication or apply authority.

#### Scenario: Verified local import
- **WHEN** an Ed25519-signed manifest, all declared asset hashes, provenance,
  license, compatibility, moderation and caller policies agree
- **THEN** verification returns an immutable content-addressed package
- **AND** performs no network request, publication, profile mutation or action

#### Scenario: Trust or provenance is incomplete
- **WHEN** the signer is unknown or revoked, the license/moderation policy is
  not caller-approved, the package is revoked, or provenance is incomplete
- **THEN** import fails closed
- **AND** the artifact cannot be previewed or used to form an apply plan

### Requirement: Companion resources and capabilities are bounded data
Packages SHALL reject archives, traversal, unknown fields, executable media,
dynamic-code capabilities and profile fields not explicitly declared by the
manifest. Asset count, encoded size, decoded per-asset and aggregate size, and
image dimensions SHALL have hard limits checked before acceptance.
The initial portable-media profile SHALL accept only structurally parsed PNG
and WAV containers and SHALL reject trailing/polyglot bytes; adding another
format requires an equally strict bounded parser and hostile fixtures.

#### Scenario: Hostile package payload
- **WHEN** a package contains JavaScript/CSS/shell capability, an unsafe path,
  undeclared profile field, hash mismatch or resource-limit violation
- **THEN** import fails before returning a verified package

### Requirement: Lifecycle evidence is reversible and non-executing
Preview, apply-plan and revert-plan records SHALL form a digest chain over a
verified package and its declared profile fields. The package seam SHALL mark
these records as non-mutating and SHALL NOT itself write the active profile.

#### Scenario: Apply plan follows preview
- **WHEN** a caller creates an apply plan for a locally verified package
- **THEN** it references the preview receipt digest and exact package digest
- **AND** a later revert plan references the apply-plan digest

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

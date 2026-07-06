## ADDED Requirements

### Requirement: Gateway-owned companion pet manifests
The gateway SHALL expose companion pet manifests as a visual layer on top of
gateway-owned companion manifests. A pet manifest SHALL include renderer,
family, skin, palette, scale, motion, sprite metadata, behaviors, actions, and
generation metadata.

#### Scenario: Client lists pets
- **WHEN** a client calls `GET /v1/agent/pets` with a valid gateway token
- **THEN** the response includes built-in and custom companion pets
- **AND** the response does not include provider credentials or executable
  extension/browser code

### Requirement: Pet draft from natural language and optional image
The gateway SHALL let a client create a custom companion pet from text and
optional sanitized image data without requiring raw profile edits.

#### Scenario: Draft pet without profile mutation
- **WHEN** a client calls `POST /v1/agent/pets`
- **THEN** the gateway persists a custom companion manifest with a `pet` spec
- **AND** the active runtime profile version is unchanged

### Requirement: Pet preview is non-mutating
The gateway SHALL preview a pet by compiling the underlying companion profile
patch without mutating the active profile.

#### Scenario: Preview pet
- **WHEN** a client calls `POST /v1/agent/pets/preview`
- **THEN** the response includes pet metadata, companion metadata, profile
  overrides, and profile preview fields
- **AND** the active profile version is unchanged

### Requirement: Pet apply uses companion profile control
The gateway SHALL apply a pet by applying its underlying companion through the
existing versioned profile store.

#### Scenario: Apply pet globally
- **WHEN** a client calls `POST /v1/agent/pets/apply` with global scope
- **THEN** the runtime profile active companion fields change on the next turn
- **AND** profile history records the companion application

### Requirement: Saved companion builder agents
The gateway SHALL expose token-guarded endpoints under `/v1/agent/pets` for
saved custom companion agents and token-free bookmark records. A saved agent
SHALL include an id, companion id, companion manifest, pet visual spec, creation
timestamp, and optional declarative rules. Rule trigger and action fields SHALL
be sanitized text and SHALL NOT be treated as executable code or authorization
for local actions.

#### Scenario: Create and fetch saved agent
- **WHEN** a client calls `POST /v1/agent/pets/agents` with text or prompt,
  optional image data URL, pet options, and rules
- **THEN** the gateway persists a custom companion and saved agent
- **AND** the active runtime profile version is unchanged
- **AND** `GET /v1/agent/pets/agents/:id` returns the saved agent for bookmark
  loading
- **AND** pet preview/apply accepts the saved `agent_id` and applies the
  underlying companion through profile control

#### Scenario: Bookmark saved agent
- **WHEN** a client calls `POST /v1/agent/pets/bookmarks` with an `agent_id` or
  `companion_id`
- **THEN** the gateway returns a bookmark shaped as `{ id, url, companion_id,
  created_at, pet, companion }`
- **AND** the URL is relative, such as `/pets/?agent=<id>`, and does not embed
  gateway tokens

### Requirement: Active companion pet lookup
The gateway SHALL expose the active companion pet manifest for the effective
agent profile without requiring clients to guess from the catalog list.

#### Scenario: Client reads active pet
- **WHEN** a client calls `GET /v1/agent/pets/active`
- **THEN** the response includes the active companion, companion manifest, and
  pet manifest for the effective profile
- **AND** it returns `null` active fields when no companion is active
- **AND** profile and pet catalog payloads include an `active_companion` object
  with companion and pet metadata

### Requirement: Pet generation stays gateway-side
The website SHALL NOT call Gemini, Vertex, or animation providers directly. The
gateway SHALL expose a non-mutating generation endpoint that returns a plan when
live generation is not configured and only calls Vertex when explicitly enabled.

#### Scenario: Generation not configured
- **WHEN** a client calls `POST /v1/agent/pets/generate` without gateway Vertex
  generation enabled
- **THEN** the response returns `status=not_configured`
- **AND** no profile or manifest is mutated

### Requirement: Website pet studio
The website SHALL expose a `/pets/` page for pet catalog search, animated
preview, drag/move behavior, upload, draft, preview, apply, and generation
controls.

#### Scenario: Local fallback
- **WHEN** the Pages proxy is not configured
- **THEN** the page still renders built-in local pet previews
- **AND** apply/generation actions report a gateway blocker instead of exposing
  credentials

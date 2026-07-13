## ADDED Requirements

### Requirement: Canonical Voice Diagnosis Commands
The gateway SHALL support self-host voice diagnosis from Moa-owned records
without requiring provider-console access. In the current implementation the
canonical diagnosis commands are `GET /v1/voice/turns/{turnId}`,
`GET /v1/sessions/{sessionId}/context`, `GET /v1/history/messages`, and
`GET /v1/voice/audio/{sessionId}/{turnId}?kind=user|assistant`; normalized
provider events SHALL come from the local `voice-provider-events.jsonl` ledger
until a dedicated diagnosis endpoint is added.

#### Scenario: Diagnose a stored turn without provider console
- **WHEN** an operator or user inspects a failed or degraded voice turn using
  the canonical diagnosis commands plus normalized provider events
- **THEN** the gateway can identify the session, branch, turn, profile version,
  provider ids, transcript, assistant output, audio refs, and recent local
  events from Moa-owned data
- **AND** provider-console access is not required to answer the first diagnosis
  question

### Requirement: Normalized Failure Phase Vocabulary
Voice diagnosis SHALL use one exact phase vocabulary:
`capture`, `transport`, `stt`, `context`, `reasoning`, `tts`, `playback`,
`storage`, and `comparison`.

#### Scenario: Diagnosis summary names a failure phase
- **WHEN** the gateway emits a diagnosis summary or replay verdict for a failed
  or degraded voice turn
- **THEN** the phase label comes from that exact set
- **AND** absent evidence is reported as unknown or omitted instead of inventing
  a provider-specific phase name

### Requirement: Diagnosis Read Paths Respect Auth And Redaction
The diagnosis read paths SHALL require the same bearer-gated gateway auth as
other stored-turn reads, and SHALL NOT expose raw provider credentials, raw
signed URLs, or unredacted provider endpoints in returned diagnostic data.

#### Scenario: Provider metadata includes secret-bearing fields
- **WHEN** diagnostic or context payloads include provider endpoint metadata
- **THEN** secret-bearing query parameters such as provider API keys are
  redacted before storage or response
- **AND** diagnosis data exposes only the redacted provider metadata needed for
  debugging

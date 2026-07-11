## ADDED Requirements

### Requirement: Canonical Context Decision Commands
The gateway SHALL use one exact context-decision command vocabulary across voice
turns: client overrides use `context_action`, the model tool name is
`context_management`, and the only valid action names are `continue`, `new`,
`fork`, and `incognito`.

#### Scenario: Explicit client action wins
- **WHEN** a client sends `context_action`
- **THEN** the gateway records that exact action as the turn's filing decision
- **AND** the model cannot override it with a different `context_management`
  tool call

#### Scenario: Model chooses incognito without a warrant
- **WHEN** the model calls `context_management` with `action: "incognito"`
- **AND** the transcript lacks an explicit incognito warrant
- **THEN** the gateway denies the incognito override
- **AND** it records the denial instead of silently persisting the model choice

### Requirement: Canonical Session Context Read Commands
The canonical durable-session context read commands SHALL be
`GET /v1/sessions/{sessionId}/context` for HTTP callers and
`get_session_context` for live-tool callers.

#### Scenario: Session context is read from Moa-owned storage
- **WHEN** a caller invokes one of the canonical session-context commands
- **THEN** the gateway returns bounded recent voice turns, chat turns, provider
  events, runs, browser tasks, and profile status from Moa-owned storage
- **AND** provider-side session memory is not required to answer the request

### Requirement: Voice Context Stays Bounded And Cache-Friendly
The voice path SHALL assemble bounded context from stable session, branch, turn,
profile, and artifact identifiers. The current voice path MAY inject that
bounded context directly instead of persisting a first-class voice context-pack
record, but any persisted pack SHALL carry stable refs plus a cache key or
content hash suitable for retry, replay, and routing reuse.

#### Scenario: A reusable context pack is materialized
- **WHEN** the gateway materializes a context pack for routing, replay, retry,
  or later retrieval
- **THEN** it records the session, branch, turn, profile, summary, provider
  event, and artifact refs used to build that pack
- **AND** it records a stable cache key or content hash for the pack contents

### Requirement: Incognito Context Leaves No Durable Pack Or PCM
An incognito voice turn SHALL remain answerable in the moment but SHALL NOT
leave a durable conversation record, durable context pack, or retained PCM
artifact.

#### Scenario: Incognito turn completes
- **WHEN** a voice turn is filed as `incognito`
- **THEN** the gateway answers the turn without appending a canonical stored
  turn record
- **AND** any buffered user or assistant PCM for that turn is deleted
- **AND** later durable-context reads do not include that turn

## ADDED Requirements

### Requirement: Canonical Broker Event
The gateway SHALL store each inbound user voice or text message as one
canonical broker event before routing it to chat, voice, workflow packages, or
agent runs.

#### Scenario: Message arrives
- **WHEN** a user sends a voice transcript or typed message
- **THEN** the gateway stores a broker event with source, normalized text,
  session/project/subproject hints, profile version, evidence references, and
  timestamp
- **AND** downstream route decisions refer back to that broker event

### Requirement: Intent History Read Model
The gateway SHALL expose a token-protected history/search read model that lets
clients and agents inspect user-authored intents and sent messages across voice,
chat, and broker surfaces.

#### Scenario: User asks what they sent
- **WHEN** a client queries history with a session id, search term, or both
- **THEN** the gateway returns matching voice turns, chat turns, and broker
  events with source, session, branch, text, route-decision references, agent-run
  references, timestamps, and available audio playback references
- **AND** the search result is derived from gateway-owned records, not provider
  session memory

#### Scenario: Brokered intent is routed
- **WHEN** a broker event produces route decisions and context packs
- **THEN** the history read model includes that broker event as an intent item
- **AND** the item includes an inspectable summary of the route decisions and
  linked context-pack identifiers

### Requirement: Semantic Intent Recall
The gateway SHALL use gbrain as a best-effort semantic recall index for intent
summaries while keeping broker events and product events as the source of truth.

#### Scenario: Broker event is stored
- **WHEN** the gateway persists a broker event and route decisions
- **THEN** it may write a concise intent summary to gbrain under the Moa memory
  namespace with the broker event id, user message summary, route decisions, and
  context-pack references
- **AND** failure to write that gbrain memory SHALL NOT prevent the broker event
  from being stored or routed

#### Scenario: History search has a semantic match
- **WHEN** a client queries sent-message history with search text
- **THEN** the gateway may include matching gbrain intent memories as semantic
  recall hints
- **AND** those hints SHALL NOT replace the canonical history items returned
  from gateway-owned voice, chat, and broker records

### Requirement: Existing Work Candidate Routing
The broker SHALL evaluate each message against active sessions, projects,
subprojects, and agent runs.

#### Scenario: Message can continue existing work
- **WHEN** a message matches an existing active session, project, subproject, or
  run
- **THEN** the broker returns a route decision that names the target, action,
  confidence, and reason

#### Scenario: Message is ambiguous
- **WHEN** multiple active targets may be relevant
- **THEN** the broker may route to multiple targets as evidence
- **AND** each route decision records its own reason

### Requirement: Non-Interrupting Routing
The broker SHALL NOT cancel existing active work merely because a new message
arrived.

#### Scenario: Message creates a fork
- **WHEN** the broker determines the message starts a new line of work
- **THEN** it may recommend or create a new forked run with `wait=false`
- **AND** existing active runs continue unless cancellation is explicit

#### Scenario: Explicit broker launch starts selected work
- **WHEN** a broker message explicitly requests agent launch
- **AND** the broker has selected a launchable workflow or new-fork route
- **THEN** the gateway starts one non-blocking `agent_run` from that route's
  context pack
- **AND** the broker response and stored broker event include the launched run id
  linked to the route decision and context pack
- **AND** the launched run records a `broker_activated` event

### Requirement: Workflow Package Selection
The broker SHALL be able to select explicit directory-backed workflows when a message
requires specialized handling.

#### Scenario: Research-heavy message arrives
- **WHEN** a message asks for exploration, comparison, online search, or a
  report
- **THEN** the broker may select a research workflow target
- **AND** the workflow receives a focused context pack with the broker event,
  relevant session/project context, and expected output shape

#### Scenario: Simple direct answer is enough
- **WHEN** the broker determines the message can be answered directly
- **THEN** it may select the direct-answer path instead of launching a larger
  research workflow

### Requirement: Broker-Launched Workers Default To Leaf Scope

Every broker-generated context pack SHALL identify its worker role and
delegation policy. The default worker role SHALL be `leaf`, with recursive
spawn and delegation denied. Recursive delegation SHALL require a non-empty
delegation ticket from the checked-in launcher profile; broker event text SHALL
NOT grant that authority.

#### Scenario: User asks a bounded worker to spawn more workers

- **WHEN** broker event text asks the selected worker to spawn or delegate
- **AND** the checked-in launcher profile has no delegation ticket
- **THEN** the generated context pack remains a leaf-worker pack
- **AND** its prompt directs the worker to complete the bounded ticket directly

#### Scenario: Checked-in profile grants bounded coordination

- **WHEN** the selected checked-in launcher profile names a delegation ticket
- **THEN** the generated context pack identifies a bounded coordinator
- **AND** the grant source and exact delegation ticket remain inspectable

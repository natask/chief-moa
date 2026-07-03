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

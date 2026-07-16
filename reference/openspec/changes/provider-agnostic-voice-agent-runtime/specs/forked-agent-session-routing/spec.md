## ADDED Requirements

### Requirement: Non-Interrupting Agent Forks
The gateway SHALL treat each user voice or chat turn as a possible async agent
fork without canceling existing active runs.

#### Scenario: User starts another line of work
- **WHEN** a user sends a spoken or typed turn while one or more agent runs are
  already active
- **THEN** the gateway stores the turn once as canonical session evidence
- **AND** the gateway may launch a new `agent_run` with `wait=false`
- **AND** existing active runs continue unless the user explicitly requests
  cancellation

#### Scenario: Turn is relevant to active work
- **WHEN** the gateway agent manager determines a new user turn is relevant to
  one or more active runs
- **THEN** the turn is linked to those runs as follow-up evidence or instruction
- **AND** the linkage records why the turn was routed to each run

#### Scenario: Turn is not actionable
- **WHEN** a newly forked or routed agent determines the turn is not relevant or
  has no executable work
- **THEN** the agent run may complete with a no-op or dismissed status
- **AND** the dismissal reason is stored for user inspection

### Requirement: Active Agent Manager Status
The gateway SHALL expose which agent forks are active and what each is trying to
do.

#### Scenario: User asks what is running
- **WHEN** the user asks which agents or threads are active
- **THEN** Moa reports active run IDs, short user-authored intents, status, latest event,
  linked session/turn IDs, and whether each run is waiting, running, blocked, or
  complete
- **AND** the same read-only projection is available to spoken and typed turns
- **AND** injected session-context scaffolding is not presented as the run intent
- **AND** answering the question does not launch, interrupt, pause, cancel, or
  retarget any run

#### Scenario: Status is rendered for text and speech
- **WHEN** an active-agent status answer is returned to a user surface
- **THEN** the display answer groups runs in Markdown by active, queued, and
  blocked lifecycle state
- **AND** the speech answer remains concise and includes the stable run ID so
  the user can refer to that agent conversationally later

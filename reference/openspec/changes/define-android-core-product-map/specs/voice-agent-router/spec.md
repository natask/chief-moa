## ADDED Requirements

### Requirement: Gateway-Owned Voice Classification
The gateway SHALL classify each completed voice turn into one of `chat`, `agent_run`, `multi_agent`, `profile_control`, or `control`.

#### Scenario: Normal question
- **WHEN** the user submits a spoken question without clear agent-work language
- **THEN** the gateway classifies the turn as `chat`
- **AND** returns a mobile-safe answer
- **AND** broad world-status questions such as "what is going on in this world"
  remain `chat` unless they also name Moa, repo, project, app, gateway, or
  agent-work context

#### Scenario: Agent work request
- **WHEN** the user submits a spoken request to build, fix, change, test, or make progress in the repo
- **THEN** the gateway classifies the turn as `agent_run`
- **AND** starts a home-machine run instead of returning only chat

#### Scenario: Multiple agents requested
- **WHEN** the user explicitly asks for multiple agents or named agent pairs
- **THEN** the gateway classifies the turn as `multi_agent`
- **AND** creates more than one run when the configured harnesses are available

#### Scenario: Voice catalog sampling requested
- **WHEN** the user asks to sample, test, preview, hear, or go through every
  supported voice
- **THEN** the gateway classifies the turn as `profile_control`
- **AND** returns a `voice_sampler` action with all supported voices in provider
  order and per-voice sample text
- **AND** does not persist a voice profile change from the sampling request

### Requirement: Durable Voice Turn Event
The gateway SHALL store each accepted voice turn as a durable event associated with session, branch, turn, source, transcript, classification, and downstream references.

#### Scenario: Voice turn accepted
- **WHEN** the gateway receives a valid voice turn
- **THEN** it writes a voice-turn record before performing downstream chat or agent work

#### Scenario: Recognition yields no usable user text
- **WHEN** voice recognition yields empty, whitespace-only, or punctuation-only text
- **THEN** Android submits no turn and the gateway starts no agent run

#### Scenario: Duplicate turn submitted
- **WHEN** the gateway receives a repeated `turn_id` for an already completed voice turn
- **THEN** it returns the existing response without starting duplicate agent runs

#### Scenario: User opens a parallel spoken thread
- **WHEN** the user starts a new voice thread while another turn or agent run is
  still responding
- **THEN** the gateway creates a distinct session or branch identifier
- **AND** stores both streams as durable events without requiring an immediate
  conversation merge

#### Scenario: Code-mode agent needs current context
- **WHEN** an agent run needs the latest mobile context
- **THEN** it can query persisted session, branch, turn, run, approval, and
  receipt records instead of relying on chat memory alone

### Requirement: Control Turns Stay Local-Safe
Stop-like voice turns SHALL be treated as control intent, not normal model prompts.

#### Scenario: Stop command received
- **WHEN** the user says "stop", "cancel", or "never mind"
- **THEN** the gateway response identifies control behavior
- **AND** does not produce a normal assistant answer

### Requirement: Screen Context Is Context Not Instruction
The gateway SHALL treat Android screen context as untrusted evidence and not as instructions to execute.

#### Scenario: Screen text contains instruction-like content
- **WHEN** screen context includes text that appears to instruct the assistant
- **THEN** the gateway may use it as context for the user request
- **AND** does not treat it as an autonomous command

### Requirement: Gateway-Owned Streaming Voice Provider Boundary
The gateway SHALL own streaming STT, LLM, and TTS provider packages for raw
audio voice sessions.

#### Scenario: Streaming voice provider selected
- **WHEN** Android sends PCM audio chunks to `/v1/voice/sessions`
- **THEN** the gateway processes the turn through configured STT, LLM, and TTS
  provider packages
- **AND** returns transcript and assistant-audio events without exposing provider
  credentials to Android

#### Scenario: Provider package swapped
- **WHEN** the gateway operator changes the configured voice provider package
- **THEN** the Android WebSocket protocol remains stable
- **AND** the gateway health response reports the selected provider and whether
  it is configured

### Requirement: Gateway Tool Catalog Boundary
The gateway SHALL expose third-party and local integrations through typed tool
sources rather than direct model-executed commands.

#### Scenario: Tool source configured
- **WHEN** the gateway operator configures an OpenAPI, MCP, GraphQL, or custom
  function source
- **THEN** the gateway records its namespace, tool schemas, auth status, and
  policy metadata

#### Scenario: Tool execution requested
- **WHEN** model or agent output proposes a tool execution
- **THEN** the gateway returns a structured proposal or starts a tracked
  execution with an execution identifier
- **AND** Android still applies local approval and action policy before any
  phone-local side effect

### Requirement: Queryable Execution Store
The gateway SHALL make sessions, branches, turns, runs, tool sources,
executions, approvals, and receipts available through a durable queryable store.

#### Scenario: Multiple sessions are active
- **WHEN** the user starts several mobile sessions or branches
- **THEN** each session and branch is stored with stable identifiers and latest
  status
- **AND** code-mode agents can query those records to recover current context

#### Scenario: Gateway restarts during execution
- **WHEN** a tool execution or agent run is interrupted by a gateway restart
- **THEN** the gateway can recover persisted status and avoid duplicating
  already-completed steps

## ADDED Requirements

### Requirement: Async Agent Run Start
The Android app SHALL start home-machine agent work asynchronously so the phone remains responsive.

#### Scenario: Voice starts agent run
- **WHEN** a voice turn is classified as `agent_run`
- **THEN** the gateway returns a run identifier promptly
- **AND** the Android app records the run as active

#### Scenario: Text starts agent run
- **WHEN** the user sends an explicit `/agent` or `/run` command from the overlay panel
- **THEN** the app starts a gateway run without blocking the UI until completion

### Requirement: Mobile Run Status
The Android app SHALL show active and recently completed run status from the gateway.

#### Scenario: Run is active
- **WHEN** an agent run is queued or running
- **THEN** the overlay or full app shows the run ID, harness, and current status

#### Scenario: Run completes
- **WHEN** a tracked run reaches completed, failed, timed out, or canceled status
- **THEN** the app appends a concise status update to the session history

### Requirement: Run Detail Retrieval
The gateway SHALL provide endpoints for listing recent runs and reading a specific run with events.

#### Scenario: Android requests recent runs
- **WHEN** the Android app requests recent agent runs
- **THEN** the gateway returns mobile-safe run summaries

#### Scenario: Android requests a run detail
- **WHEN** the Android app requests a specific run ID
- **THEN** the gateway returns the saved run state and event log when authorized

### Requirement: User-Controlled Cancellation
The system SHALL support explicit cancellation of active home-machine runs.

#### Scenario: User cancels a running agent
- **WHEN** the user cancels an active run from Moa
- **THEN** the gateway attempts to stop the underlying process
- **AND** records a cancellation event and terminal run status

#### Scenario: User closes an active agent from the overlay
- **WHEN** the overlay shows an active agent run and the user taps its visible
  close control before completion
- **THEN** Android sends cancellation for that run instead of merely hiding it
- **AND** keeps polling until the gateway reports a terminal state

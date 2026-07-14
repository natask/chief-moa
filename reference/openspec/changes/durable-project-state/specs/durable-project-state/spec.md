## ADDED Requirements

### Requirement: Durable Project Brief
The gateway SHALL keep a project brief independently of agent sessions.

#### Scenario: User records project state
- **WHEN** an authenticated user updates a project brief
- **THEN** the gateway stores bounded problem, desired outcome, current state,
  and next-step text
- **AND** a later project read returns the same durable state

#### Scenario: User returns to a project
- **WHEN** the user selects a project in the local gateway console
- **THEN** the console shows the durable project brief before launching work
- **AND** the user does not need to identify or manage prior agent sessions

#### Scenario: Project work launches
- **WHEN** the gateway launches an agent run for a saved project
- **THEN** the run context includes the saved project brief
- **AND** the disposable worker can advance the durable state without relying
  on a prior agent session

#### Scenario: Unauthorized update
- **WHEN** a caller without gateway authorization updates a project
- **THEN** the gateway rejects the mutation

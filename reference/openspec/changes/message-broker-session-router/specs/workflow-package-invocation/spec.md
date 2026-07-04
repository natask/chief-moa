## ADDED Requirements

### Requirement: Workflow Context Pack
Workflow packages SHALL receive focused context packs rather than raw unbounded
chat history.

#### Scenario: Broker invokes a workflow package
- **WHEN** the broker selects a workflow package
- **THEN** the gateway constructs a context pack containing the broker event,
  workflow directory, instruction file, relevant session/project/subproject
  context, active run summaries, constraints, and expected output

#### Scenario: Broker launch activates a workflow package
- **WHEN** a broker request explicitly asks to launch the selected workflow
- **THEN** the gateway starts a non-blocking agent run using the workflow context
  pack's launcher prompt
- **AND** the context pack records the launch result with route decision id,
  agent run id, launcher profile id, harness, and `wait=false`

### Requirement: Inspectable Workflow Output
Workflow output SHALL be stored as a durable result linked to the broker event
and route decision.

#### Scenario: Workflow completes
- **WHEN** a workflow returns a report, plan, patch, or answer
- **THEN** the gateway stores the output with the broker event id, route
  decision id, workflow name, status, and summary

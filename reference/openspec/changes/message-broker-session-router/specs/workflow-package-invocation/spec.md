## ADDED Requirements

### Requirement: Workflow Context Pack
Workflow packages SHALL receive focused context packs rather than raw unbounded
chat history.

#### Scenario: Broker invokes a workflow package
- **WHEN** the broker selects a workflow package
- **THEN** the gateway constructs a context pack containing the broker event,
  workflow directory, instruction file, relevant session/project/subproject
  context, active run summaries, constraints, and expected output

### Requirement: Inspectable Workflow Output
Workflow output SHALL be stored as a durable result linked to the broker event
and route decision.

#### Scenario: Workflow completes
- **WHEN** a workflow returns a report, plan, patch, or answer
- **THEN** the gateway stores the output with the broker event id, route
  decision id, workflow name, status, and summary

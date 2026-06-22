## ADDED Requirements

### Requirement: Skill Context Pack
Skill workflows SHALL receive focused context packs rather than raw unbounded
chat history.

#### Scenario: Broker invokes a skill
- **WHEN** the broker selects a skill workflow
- **THEN** the gateway constructs a context pack containing the broker event,
  relevant session/project/subproject context, active run summaries, constraints,
  and expected output

### Requirement: Inspectable Skill Output
Skill workflow output SHALL be stored as a durable result linked to the broker
event and route decision.

#### Scenario: Skill completes
- **WHEN** a skill workflow returns a report, plan, patch, or answer
- **THEN** the gateway stores the output with the broker event id, route
  decision id, workflow name, status, and summary

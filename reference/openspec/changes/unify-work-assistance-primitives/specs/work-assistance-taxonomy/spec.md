## ADDED Requirements

### Requirement: Product layers use distinct canonical names
Chief Moa SHALL identify the product/surface family, Aggie SHALL identify the
personal-agent session/routing layer, and each Surface SHALL own its platform UI
and local authority.

#### Scenario: A capability differs by platform
- **WHEN** a surface does not support arbitrary cross-app observation or action
- **THEN** it advertises that limitation honestly
- **AND** shared Aggie session identity does not imply capability parity

### Requirement: Observation and suggestion are inert
An Observation SHALL remain ephemeral evidence and an Assistance Suggestion
SHALL remain an expiring user-visible proposal until explicitly accepted.

#### Scenario: Suggestion expires or is dismissed
- **WHEN** the user does not accept a suggestion
- **THEN** no broker event, task, run, action proposal, or remote context record
      is created from it

#### Scenario: Suggestion is accepted
- **WHEN** the user accepts after reviewing its disclosure
- **THEN** the disclosed promotion contract MAY create at most one explicit
      broker event
- **AND** routing, task creation, run launch, and local action remain separate
      inspectable decisions

### Requirement: Conversation, organization, procedure, and execution remain distinct
Projects/Workstreams SHALL organize durable focus/progress, Sessions/Threads
SHALL organize conversation, Tasks SHALL represent outcomes, Workflows SHALL
represent reusable procedures, and Runs SHALL represent execution attempts.

#### Scenario: Task is retried
- **WHEN** execution fails and the same desired outcome is retried
- **THEN** the Task identity remains stable
- **AND** a new Run records the new attempt

#### Scenario: Work crosses projects
- **WHEN** one goal spans multiple Projects
- **THEN** a Workstream may link those Projects without becoming a Workflow or
      merging their histories

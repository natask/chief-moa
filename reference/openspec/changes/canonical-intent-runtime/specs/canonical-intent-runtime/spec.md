## ADDED Requirements

### Requirement: Intent is canonical desired-outcome state
The gateway SHALL represent one desired outcome as a versioned intent aggregate
derived from append-only product events. Sessions, threads, projects/repo
bindings, work nodes/tasks, runs, artifacts, receipts, and telemetry SHALL NOT
silently become competing intent authorities.

#### Scenario: Restart rebuilds the same intent
- **WHEN** the gateway restarts after intent lifecycle events were appended
- **THEN** replay produces the same state, relations, focus, outcome, and next
  step
- **AND** an idempotent command does not duplicate a transition

### Requirement: Admission precedes execution and context retrieval
Every non-incognito turn SHALL be captured before routing, launch, tool
execution, or answer generation. Explicit new/fork/incognito selection SHALL
occur before thread recency or semantic recall is assembled.

#### Scenario: Explicit clean slate is actually cold
- **WHEN** a turn is admitted with `context_action=new`
- **THEN** the answer context may include standing user facts
- **AND** it includes no caller-thread recency or semantic intent history
- **AND** a failed branch creation does not fall back to default

### Requirement: Temporary child returns focus
A bounded transactional command SHALL be representable as a child intent with a
return target. Completion SHALL carry its action receipt/outcome and pop focus
exactly once to the parent.

#### Scenario: Profile change returns to parent work
- **WHEN** the user temporarily changes a voice/profile setting while another
  intent is focused
- **THEN** the gateway pushes a child, applies the bounded profile tool, records
  the profile-version receipt, completes the child, and restores the parent

### Requirement: Rehydration is bounded and sourced
The gateway SHALL expose a bounded project-or-intent brief containing objective,
lifecycle/focus, decisions, relations, plans, attempts, blockers, artifacts,
receipts, outcome, lessons, and next step with source receipts and truncation.

#### Scenario: Return after months
- **WHEN** the user reopens a project after prior intent events and runs
- **THEN** one brief identifies current priorities and unresolved work
- **AND** every included fact is linked to a source event/artifact/receipt
- **AND** replay bounds and omissions are reported


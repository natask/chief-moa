# Core product execution

## ADDED Requirements

### Requirement: granular implementation ownership

The program SHALL split implementation into tickets with one observable result,
exclusive path ownership, named dependencies, and an exact verification check.
Shared paths SHALL have one active owner and SHALL integrate in sequence.

#### Scenario: independent tickets run in parallel

- **WHEN** two ready tickets own disjoint paths and resources
- **THEN** separate agents may implement them in parallel
- **AND** each agent runs its focused acceptance check

#### Scenario: shared paths run in sequence

- **WHEN** two tickets need the same source file or deployment authority
- **THEN** the coordinator queues the later ticket
- **AND** the later ticket starts from the committed result of the earlier one

### Requirement: UI implementation uses the designated UI harness

Browser, Android, and shared visual implementation tickets SHALL run through
Claude Code. UI acceptance SHALL include named rendered states and current
surface verification.

#### Scenario: UI contract is ready

- **WHEN** a UI ticket's data and authority dependencies have frozen fixtures
- **THEN** the coordinator launches the Claude Code UI ticket
- **AND** an independent visual QA lane reviews fresh screenshots

### Requirement: combined candidate verification

The program SHALL run full QA against one immutable combined candidate after
focused ticket checks pass. Promotion SHALL keep the existing rollback,
compatibility, interruption, backup, restore, and smoke gates.

#### Scenario: a ticket passes its focused check

- **WHEN** one ticket passes its local acceptance check
- **THEN** that result may be committed as a narrow unit
- **AND** it SHALL NOT count as combined release verification

#### Scenario: a promotion gate is missing

- **WHEN** preview, rollback, compatibility, interruption, backup, restore, or
  smoke evidence is missing
- **THEN** the candidate remains unpromoted
- **AND** the program records the exact blocker

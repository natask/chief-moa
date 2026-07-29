# Companion voice program coordination

## ADDED Requirements

### Requirement: One program links the user's requested outcomes

The program SHALL preserve one source-linked delivery identity for the user's
Android voice, interface, transcript, coaching, companion, browser, calendar,
macOS, and agent-delivery outcomes. It SHALL link each outcome to the existing
OpenSpec change that owns its behavior.

#### Scenario: A coordinator resumes the request

- **WHEN** a coordinator opens the program after another agent session ends
- **THEN** the program identifies the current milestone, owning changes,
  dependencies, candidate, evidence, blockers, and next action
- **AND** it does not require the original chat transcript to recover scope

### Requirement: Existing behavior contracts remain authoritative

The program SHALL NOT create a second voice, transcript, coaching, intent,
companion, account, action, or release authority. A checked task in another
change SHALL remain a source claim until exact verification evidence is linked
to the current candidate.

#### Scenario: Architecture and task state disagree

- **WHEN** architecture describes behavior as shipped while its source tasks
  remain open or stale
- **THEN** the program marks the behavior for claims reconciliation
- **AND** it neither reimplements the behavior nor marks it verified from text
  alone

### Requirement: Stable diagnosable Android voice is the first milestone

The program SHALL gate later surface expansion on one exact Android and gateway
candidate that passes the first-frame, capture, transcript, commit,
interruption, terminal-failure, diagnosis, and endpoint-playback checks in this
change.

#### Scenario: Repository checks pass without phone evidence

- **WHEN** gateway and Android repository checks pass
- **AND** the exact APK lacks valid physical-phone milestone evidence
- **THEN** the first milestone remains incomplete
- **AND** companion, calendar, and macOS implementation remain later stages

### Requirement: Parallel work preserves file and authority ownership

The program SHALL allow independent lanes to run in parallel only when they own
separate files and acceptance cells. Shared Android or browser implementation
files SHALL have one active owner and SHALL integrate in dependency order.
Evaluation, repair, and acceptance SHALL remain separate where the owning
principal contract requires that split.

#### Scenario: Two Android tickets touch the overlay

- **WHEN** two tickets need the same overlay source files
- **THEN** the coordinator runs them in sequence or gives them to one owner
- **AND** a separate verifier checks the joined candidate

### Requirement: Companion and calendar stay explicit follow-ups

The program SHALL stage `cross-surface-companion-presence` and
`calendar-planning-intents` as new changes after the first milestone is smoked.
This change SHALL NOT grant authority to implement either follow-up.

#### Scenario: An agent starts companion or calendar work early

- **WHEN** no accepted follow-up change and no smoked first milestone exist
- **THEN** the coordinator records the proposal and dependency
- **AND** starts no companion-presence or calendar implementation from this
  program change

### Requirement: Completion requires exact release evidence

The program SHALL keep built, previewed, installed, published, promoted, and
smoked states separate. It SHALL report completion only when the required
verification and release evidence bind to the same candidate and the active
promotion safety gate passes.

#### Scenario: An Android APK builds but is not installed

- **WHEN** the exact APK passes repository checks but has no phone install and
  smoke receipts
- **THEN** the program reports it as built or previewed only
- **AND** it does not report the Android milestone as delivered

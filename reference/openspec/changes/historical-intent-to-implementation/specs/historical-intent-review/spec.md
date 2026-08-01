# Historical Intent Review

## ADDED Requirements

### Requirement: Historical intent is evidence until current approval

The system SHALL preserve source and provenance when reviewing historical user
intent and MUST NOT turn historical messages, transcripts, or model output into
implementation or deployment authority without current user approval.

#### Scenario: an old request appears incomplete

- GIVEN a bounded history scan finds an apparently unimplemented request
- WHEN the review is produced
- THEN it identifies the supporting evidence and uncertainty
- AND creates no code change or execution run without current approval.

### Requirement: Project-linked development history is inventoried without becoming authority

The system SHALL support a read-only inventory of project-linked Entire
metadata and recoverable Entire checkpoint transcripts. It SHALL distinguish
direct user evidence from known system, supervisor, agent-instruction,
notification, environment, and local-command wrappers. Exact duplication SHALL
NOT increase confidence, and raw excerpts SHALL be omitted by default.

#### Scenario: repeated supervisor prompts dominate the stored corpus

- GIVEN many Entire sessions repeat the same automated supervisor prompt
- WHEN the local audit runs
- THEN it classifies those records separately from direct user evidence
- AND reports exact duplicates without treating repetition as stronger intent
- AND preserves a content digest and source reference for later review.

### Requirement: Applicability is aligned before cross-surface propagation

Each intent candidate SHALL identify whether it is a universal product
invariant, cross-surface default, surface-specific rule, experiment, or
concern/question. Cross-surface defaults SHALL name any Surface exception and
its rationale. The system MUST NOT generalize one Surface's feedback solely
because an agent copied it into another Surface's spec.

#### Scenario: Android feedback may apply to browser and desktop

- GIVEN a user correction was originally made while reviewing Android
- WHEN historical intent review proposes it as a cross-surface default
- THEN the review shows the original Android evidence and proposed scope
- AND the user can accept the default, restrict it, add exceptions, or keep it
  as an experiment before implementation tickets are generated.

## ADDED Requirements

### Requirement: Visual QA captures real deterministic renders
The visual-QA pipeline SHALL capture the real Android and browser surfaces for
the complete deterministic state matrix and SHALL bind each image to exact
candidate and renderer metadata.

#### Scenario: A required state cannot render
- **WHEN** a capture adapter cannot inject or observe a required state in the real surface
- **THEN** the run reports that state missing and does not substitute a mock

### Requirement: References are inventoried without acquisition
The pipeline SHALL inventory only repository-supplied reference images with
hash and provenance metadata.

#### Scenario: Expected Gemini references are absent
- **WHEN** the configured reference path does not exist
- **THEN** evidence records `missing_reference`
- **AND** the pipeline does not download, generate, or infer a substitute

### Requirement: Review has two evidenced refinement rounds
Every accepted visual candidate SHALL have two complete capture and critique
rounds, and every first-round finding SHALL have a human disposition.

#### Scenario: Round two starts
- **WHEN** round-one critique and dispositions are complete
- **THEN** every required state is recaptured from the round-two candidate
- **AND** no round-one screenshot is reused as round-two evidence

### Requirement: Opus identity is proven
Visual critique SHALL invoke Claude Code with `--model opus` and record both the
requested model and model identity returned by the tool.

#### Scenario: Returned model metadata is missing or different
- **WHEN** Claude Code omits model metadata or reports a non-Opus model
- **THEN** critique is marked incomplete and cannot support visual acceptance

### Requirement: Evidence is complete and reviewable
The run SHALL retain screenshot hashes, environment metadata, critique inputs
and outputs, human dispositions, parity results, and exact round-two acceptance
hashes in the documented schema.

#### Scenario: A screenshot changes after critique
- **WHEN** its current SHA-256 differs from the critique or acceptance record
- **THEN** the evidence is stale and acceptance fails

### Requirement: Parity preserves semantics rather than pixels
Android and browser SHALL use equivalent visual hierarchy, companion scale,
transcript adjacency, bounded streaming/expansion behavior, and affordance
meaning while allowing documented platform-native differences.

#### Scenario: Both surfaces look polished but expansion differs
- **WHEN** one surface cannot reveal the full bounded transcript and copy action
- **THEN** parity fails even if both screenshots are individually attractive

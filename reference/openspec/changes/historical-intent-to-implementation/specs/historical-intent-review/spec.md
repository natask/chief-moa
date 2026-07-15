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


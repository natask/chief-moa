# Companion Character Library

## ADDED Requirements

### Requirement: Character packages remain reviewable and authority-bounded

The system SHALL represent a companion character as a sanitized manifest with
persona, voice, provenance, animation verbs, and visibility, and SHALL require
review and consent before publishing shared packages or enrolling cloned voices.

#### Scenario: discovered character remains a draft

- GIVEN a discovery worker proposes a character from public references
- WHEN the proposal is stored
- THEN it remains unpublished until review
- AND reference media grants no execution or voice-enrollment authority.


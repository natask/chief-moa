# Modification Request Capture

## ADDED Requirements

### Requirement: In-app reports are reviewable proposals

The app SHALL let a user review and redact bounded surface, build, session, and
optional screenshot evidence before submitting a modification proposal, and
MUST NOT treat that evidence as repository or execution authority.

#### Scenario: user reports a visible defect

- GIVEN the user invokes the report flow from a supported surface
- WHEN they approve the redacted evidence bundle
- THEN the gateway stores a durable proposal with provenance
- AND no implementation run begins unless separately authorized.


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

### Requirement: interaction feedback binds to exact release bytes

The gateway SHALL accept `interaction_feedback.v1` only when the feedback
targets exactly one deployment and its surface, release ID, candidate ID, and
artifact SHA-256 match a candidate stored for that deployment.

#### Scenario: user comments on a preview

- GIVEN the user is testing a preview candidate
- WHEN they submit feedback with the candidate's exact release binding
- THEN the gateway stores the feedback against that deployment
- AND the stored binding identifies the artifact bytes the user tested.

#### Scenario: feedback names different artifact bytes

- GIVEN a deployment stores one candidate artifact digest
- WHEN feedback supplies a different artifact digest
- THEN the gateway rejects the feedback
- AND the feedback is not attached to the deployment.

### Requirement: interaction evidence keeps source context

The gateway SHALL preserve the bounded raw comment as received and SHALL allow
typed video evidence refs, bounded media time ranges, and bounded browser
snapshot anchors with capture time.

#### Scenario: user anchors a comment to an interaction

- GIVEN the user records a video note or captures a browser snapshot
- WHEN they submit a raw comment with time or snapshot anchors
- THEN the gateway stores the raw comment without trimming or rewriting it
- AND the stored anchors retain their typed evidence relationship.

### Requirement: derived context remains an unreviewed proposal

The gateway SHALL derive the same bounded context proposal for the same
accepted comment, release binding, evidence refs, and anchors. It SHALL mark the
proposal `unreviewed` and MUST NOT treat it as execution authority.

#### Scenario: gateway derives feedback context

- GIVEN the gateway accepts exact release-bound interaction feedback
- WHEN it derives text that labels the comment, release, evidence, and anchors
- THEN the derived record reports deterministic derivation and `unreviewed`
  status
- AND no run, edit, release switch, deployment, or promotion starts.

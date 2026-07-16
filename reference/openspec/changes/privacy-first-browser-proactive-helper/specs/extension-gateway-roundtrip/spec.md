## MODIFIED Requirements

### Requirement: Unified Browser Agent Turn Path
The gateway SHALL expose `POST /v1/browser/turns` as the canonical browser-agent
turn path for explicitly invoked typed page questions, describe-page requests,
and committed browser voice transcripts. Browser turns SHALL be linked to a
session, branch, turn id, source kind, browser-agent owner, page evidence, and
status resource. There is no separate context-free proactive turn path.

#### Scenario: Typed page question enters browser-agent turn path
- **WHEN** the user submits a question about the current page and approves the
      context required by that flow
- **THEN** the extension posts the question and approved context to
      `POST /v1/browser/turns`
- **AND** the rendered reply originates from that browser-agent turn

#### Scenario: Describe page excludes screenshots
- **WHEN** a supported explicit context choice includes page text or DOM evidence
      but excludes screenshots
- **THEN** the outbound preview contains no screenshot
- **AND** the approved useful context uses the normal browser-agent turn path

### Requirement: Browser Action Receipts
Every negotiated browser-agent action SHALL produce the normal receipt. For an
action that is executed, refused, or deferred, that receipt is linked to
session, branch, turn, task, proposal, page evidence, approval, result, and
timestamp. Retiring proactive suggestions does not weaken the proposal,
validation, approval, or receipt boundary.

#### Scenario: Negotiated browser action is executed or refused
- **WHEN** a browser-agent turn preserves a validated action proposal
- **THEN** the extension records the normal fully linked browser action receipt
- **AND** the gateway links it to the browser-agent turn and related task

## REMOVED Requirements

### Requirement: Proactive Gateway Turn Is A Separate Strict Capability
**Reason**: A packaged generic prompt with no page meaning does not provide
useful proactive assistance, even when its privacy and execution boundaries are
strict.

**Migration**: Remove `POST /v1/proactive/turns` and its browser caller. Keep
default-off background connectivity, heartbeat redaction, and the normal
browser-turn proposal/approval/receipt controls.

### Requirement: Proactive Gateway Turn Bypasses Execution And Persistence
**Reason**: The endpoint existed only to support the retired context-free
suggestion flow.

**Migration**: Future user-approved context uses `POST /v1/browser/turns` after
an explicit context-type selection and exact outbound preview.

### Requirement: Proactive Gateway Smoke Proves The Negative Boundary
**Reason**: The capability and its focused smoke are retired together.

**Migration**: Verification must prove the proactive endpoint is unavailable,
the UI no longer exposes Local suggestions, and ordinary browser turns retain
their existing authority and receipt boundaries.

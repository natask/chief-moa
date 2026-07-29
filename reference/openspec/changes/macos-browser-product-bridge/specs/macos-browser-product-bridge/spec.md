# macOS-Browser Product Bridge Specification

## ADDED Requirements

### Requirement: Mac and browser remain separate products

The system SHALL provide the native Mac companion and browser extension as
separately installable and usable products with independent UI, permissions,
local context, execution authority, and release lifecycle.

#### Scenario: Browser product runs without Mac

- **WHEN** the extension is installed and authenticated without `MoaMac.app`
- **THEN** browser conversation, page evidence, and locally approved browser
  work remain available
- **AND** no Mac identity or permission is required

#### Scenario: Mac product runs without extension

- **WHEN** `MoaMac.app` is installed and authenticated without a browser client
- **THEN** Mac conversation and Mac-local capabilities remain available
- **AND** browser delegation reports unavailable instead of using AX fallback

### Requirement: Delegation is explicit and target-bound

A Mac-originated browser effect SHALL require a user-confirmed bounded request
bound to one compatible browser device, request identity, arguments digest,
scope, approval class, and expiry.

#### Scenario: User delegates a browser outcome

- **WHEN** the user explicitly asks the Mac product to open a valid HTTPS URL in
  a selected online browser
- **THEN** the gateway queues one request for that browser device
- **AND** another device cannot claim it
- **AND** repeated submission with the same idempotency key does not create a
  second effect

#### Scenario: Routing is only inferred

- **WHEN** a Mac turn does not explicitly grant browser execution
- **THEN** the product asks for confirmation naming the target and bounded
  outcome before queuing a side effect

### Requirement: Browser-local authority remains local

The gateway and Mac product SHALL treat delegation as a proposal. The extension
SHALL independently validate, approve when required, execute, and receipt the
request under browser-local policy.

#### Scenario: Sensitive browser action requires local checkpoint

- **WHEN** a delegated request would submit, publish, purchase, send, enter a
  credential, or use separately gated raw CDP authority
- **THEN** the browser product applies its normal local approval checkpoint
- **AND** Mac confirmation does not bypass it

#### Scenario: Request becomes stale

- **WHEN** target, scope, observation, expiry, arguments digest, capability, or
  cancellation state fails revalidation before an effect
- **THEN** the extension performs no effect
- **AND** posts a reason-coded blocked or terminal receipt

### Requirement: Products share work identity, not UI state

The gateway SHALL expose one monotonic request/progress/receipt projection to
both products. Each product SHALL render it in its own UI and SHALL NOT
synchronize transient presentation or permission state.

#### Scenario: Browser task completes

- **WHEN** the selected extension completes a delegated request
- **THEN** it posts an idempotent terminal receipt bound to request, target, and
  arguments digest
- **AND** both products can show the same outcome identity
- **AND** raw page content, cookies, credentials, and browser storage are absent
  from progress and receipt records

### Requirement: Disconnection fails visibly and safely

Disconnected work SHALL remain bound to its selected target, SHALL expire after
a bounded lease, and SHALL never silently move to another executor or platform
automation path.

#### Scenario: Selected browser is offline

- **WHEN** a target-bound request reaches a browser that is offline or stale
- **THEN** it remains visibly queued or blocked only until expiry
- **AND** no browser or Mac-local effect occurs
- **AND** it is not retargeted without a new explicit user decision

#### Scenario: Connection drops after claim

- **WHEN** the extension loses gateway connectivity during a claimed request
- **THEN** it stops before any new effect once its lease cannot be renewed
- **AND** reconciles an already completed effect by request identity after
  reconnect without repeating it

### Requirement: First slice proves the complete handoff

The first implementation SHALL prove a Mac-originated `browser.tab.open` request
for one validated HTTPS URL through the gateway to one selected extension and
back to a terminal receipt.

#### Scenario: Successful first handoff

- **WHEN** the user delegates one valid HTTPS URL from Mac to a fresh compatible
  browser device
- **THEN** the extension opens exactly one tab
- **AND** the Mac and browser report the same terminal request identity

#### Scenario: Unsafe first handoff input

- **WHEN** the URL is invalid, non-HTTPS, expired, cancelled, duplicated, or
  claimed by the wrong device
- **THEN** no tab opens
- **AND** the request records a reason-coded safe outcome

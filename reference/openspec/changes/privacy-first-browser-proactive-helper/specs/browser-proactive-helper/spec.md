## ADDED Requirements

### Requirement: Proactive observation requires a scoped local grant
The browser extension SHALL keep proactive observation off by default and SHALL
observe one top-level tab/document/frame only after an explicit trusted user
grant lasting no more than ten minutes.

#### Scenario: Extension or page starts without a grant
- **WHEN** the extension service worker or a matching page starts
- **THEN** no proactive page sampler runs
- **AND** no proactive suggestion appears
- **AND** no gateway request occurs because of startup

#### Scenario: User enables local suggestions
- **WHEN** the user chooses Local suggestions for this tab on a non-sensitive page
- **THEN** the extension binds an ephemeral grant to that tab, document id, and
      top-frame id before asynchronous initialization
- **AND** shows a persistent local-tab observation indicator
- **AND** keeps every observed signal in extension memory

#### Scenario: Page script synthesizes a proactive control click
- **WHEN** page script dispatches or invokes a synthetic click on the grant,
      review, dismiss, or stop control
- **THEN** the extension ignores the activation because it is not trusted
- **AND** it does not create a grant, open confirmation, dismiss state, or send
      a gateway request

### Requirement: Local classification is structural and deterministic
The proactive classifier SHALL accept only bounded structural counts/booleans
and SHALL create at most one generic suggestion per grant without model or
gateway inference.

#### Scenario: Document-like page reaches the dwell threshold
- **WHEN** the granted visible page contains document-like structural affordances
- **THEN** the local classifier may suggest a generic document assistance action
- **AND** it does not read title, URL, selected text, body text, or control values

#### Scenario: Card is dismissed
- **WHEN** the user dismisses the suggestion
- **THEN** the card and grant are purged
- **AND** no HTTP(S) or WebSocket request occurs

### Requirement: Local classification has a bounded resource lifetime
The extension SHALL perform at most one bounded structural traversal after a
visible-page dwell, clamp every count to 100, stop when all useful counters are
saturated, and stop the local observation lifecycle when no card matches. It
SHALL NOT install an unbounded page mutation observer for this capability.

#### Scenario: No classifier rule matches
- **WHEN** the single bounded structural sample produces no suggestion
- **THEN** the extension stops the sampler, status timer, and grant
- **AND** it does not traverse the page again or make a network request

### Requirement: Recognized sensitive pages are suppressed
The extension SHALL suppress proactive observation when a closed, tested set of
credential/payment autocomplete tokens, password fields, form metadata markers,
or auth, recovery, OAuth, checkout, billing, payment, banking, wallet, health,
tax/payroll, vault, or security/admin route markers matches. Detection SHALL use
route/DOM metadata without reading field values and SHALL not claim to identify
every semantically sensitive page.

#### Scenario: Password or payment marker is present
- **WHEN** a password field, credential autocomplete token, or payment marker is detected
- **THEN** the current document enters a suppressed state
- **AND** no structural sample or suggestion is produced
- **AND** only a bounded local reason code is retained

### Requirement: Grants revoke completely
The extension SHALL purge the grant, pending confirmation, and derived state on
expiry, dismissal, manual stop, navigation/reload/history change, pagehide, tab
close, document/frame mismatch, service-worker restart, newly detected
sensitivity, gateway-destination change, or entry into a normal command, voice,
ambient, or browser-agent workflow.

#### Scenario: Granted tab navigates
- **WHEN** the granted tab begins a top-level navigation or changes history/hash
- **THEN** the grant and card are removed before the new document is observed

#### Scenario: Stale document sends a message
- **WHEN** a message's tab, document id, or frame id does not match the active grant
- **THEN** the service worker rejects it without reading or storing its signals

#### Scenario: User starts another extension workflow
- **WHEN** the user starts a normal command, voice, ambient, or browser-agent
      workflow while a grant or confirmation is pending
- **THEN** the proactive grant and confirmation are revoked before that workflow
      proceeds

### Requirement: Passive gateway connectivity is disabled by default
Fresh and migrated installations SHALL NOT persist or contact a packaged hosted
gateway merely because the extension loaded. All remote browser claim polling
and heartbeat SHALL require current versioned background-automation consent and
SHALL fail closed.

#### Scenario: Legacy install migrates
- **WHEN** privacy schema v1 first runs without current consent
- **THEN** it disables background automation and clears its poll alarm
- **AND** preserves user-saved gateway credentials locally
- **AND** removes URL/title from persisted browser-owner state
- **AND** performs no migration network request

#### Scenario: Tool claim alarm fires without consent
- **WHEN** a browser claim alarm fires while automation consent is absent or unreadable
- **THEN** task, agent-task, tool-request, and heartbeat gateway calls do not run

### Requirement: Opted-in heartbeat excludes page identity
An explicitly enabled device heartbeat SHALL carry only operational identity,
surface/version/status, and the bounded local tool manifest.

#### Scenario: Active owner has page metadata
- **WHEN** heartbeat runs while local owner state contains URL, title, result, or instruction
- **THEN** none of those fields and no active-owner object appear in the request

### Requirement: Background connectivity state is explicit and independent
The proactive disclosure SHALL display background automation connectivity as
exactly `enabled` or `disabled` according to current versioned consent. This
informational state SHALL neither grant proactive observation nor authorize its
request, and the proactive grant SHALL NOT authorize other connectivity.

#### Scenario: Background automation consent is enabled
- **WHEN** a user starts a local proactive grant while current background
      automation consent exists
- **THEN** the local preview and extension-owned confirmation report background
      connectivity as enabled
- **AND** final proactive authorization still requires its own trusted Allow
      activation

### Requirement: The page card cannot authorize a request
The on-page suggestion card SHALL be a visibly non-authoritative preview. Every
proactive control in the page SHALL require trusted activation. A trusted Review
activation MAY only request an extension-owned `proactive-confirm.html` window;
it SHALL NOT itself consume the grant or authorize networking.

#### Scenario: Host page changes or covers the local card
- **WHEN** hostile page DOM or CSS rewrites, hides, overlays, or moves the local
      preview and its controls
- **THEN** the page still cannot send the proactive request
- **AND** any trusted Review activation can only open an unmodified
      extension-owned confirmation window

### Requirement: Final proactive authorization is extension-owned and exact
Before Allow is enabled, `proactive-confirm.html` SHALL display the immutable
request assembled by the worker: exact request URL, `POST`,
`Content-Type: application/json`, authorization-header presence with its value
hidden, `redirect: error`, the exact JSON body and SHA-256 body digest, Chief
Moa persistence/retention exclusions, a configured-provider processing warning,
the complete excluded data/capability categories, and explicit background
connectivity state. Only a trusted Allow activation from that exact extension
origin/path/token SHALL authorize the request.

#### Scenario: User reviews canonical request details
- **WHEN** a valid extension-owned confirmation opens
- **THEN** its displayed URL, method, content type, authorization presence,
      redirect policy, JSON body, and body digest match the eventual request
- **AND** it says Chief Moa does not add this request or response to conversation,
      task, workflow, broker, or agent-run storage
- **AND** it says the configured model provider still processes the packaged
      prompt under that provider's data policy
- **AND** it says no screenshot, page content/identity/evidence, observed count,
      action, task, workflow, broker, or agent-run instruction is included

#### Scenario: Script synthesizes the final Allow activation
- **WHEN** script invokes or dispatches a synthetic click on Allow
- **THEN** the extension ignores it
- **AND** no request is issued

### Requirement: Suggestion acceptance is revalidated and exactly once
The extension SHALL bind confirmation creation and final authorization to the
exact top-level tab/document/frame. It SHALL revalidate document/frame,
sensitivity, expiry, destination digest, exact request URL, body digest,
confirmation identity, and grant identity after asynchronous work. It SHALL then
atomically set the pending confirmation to consuming and delete the grant before
issuing at most one `POST /v1/proactive/turns` request tagged
`proactive_accept_v1` with `redirect: error` and no client retry.

#### Scenario: User confirms a current suggestion
- **WHEN** the extension-owned sender, document/frame, expiry, destination,
      immutable body, and sensitivity checks all pass
- **THEN** the matching confirmation and grant change to consuming and the
      grant is removed before the request
- **AND** only inert in-flight confirmation status remains until the bounded
      request settles, after which it is purged
- **AND** one text-only `POST /v1/proactive/turns` request is sent
- **AND** it contains no URL, title, body text, elements, screenshot, form value,
      cookie, history, observed structural count, page-evidence, action, task,
      workflow, broker, or agent-run field
- **AND** unexpected action-shaped response fields remain inert protocol violations

#### Scenario: Document changes while confirmation is open
- **WHEN** the original top-level document/frame navigates or no longer answers
      the exact-document sensitivity check before Allow completes
- **THEN** the extension revokes the grant and confirmation
- **AND** it sends no request

#### Scenario: Approved endpoint redirects
- **WHEN** the exact approved endpoint returns a redirect
- **THEN** fetch fails with the `redirect: error` policy
- **AND** the disclosed body is not forwarded to the redirect destination

#### Scenario: Text-only response contains action-shaped fields
- **WHEN** the proactive text response contains any nested or scalar `action`,
      `actions`, `proposal`, or `proposals` key, including a null-valued key, or
      the bounded scan reaches its depth/node limit before proving absence
- **THEN** the extension refuses it locally and writes a bounded content-free
      refusal receipt through a serialized write
- **AND** it does not execute the field or make a second network request

#### Scenario: User double-clicks or repeats acceptance
- **WHEN** acceptance is received after the grant was consumed
- **THEN** the duplicate is rejected
- **AND** no second gateway request occurs

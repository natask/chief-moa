## ADDED Requirements

### Requirement: Accessibility permission is not observation consent
The macOS surface SHALL request Accessibility trust only after an explicit user
action and SHALL require a separate visible, one-app, time-bounded product grant
before reading AX context.

#### Scenario: App starts with OS trust already granted
- **WHEN** `Ag.app` launches while Accessibility trust exists
- **THEN** no AX observer or snapshot starts
- **AND** no network request or login persistence is created

#### Scenario: User grants proactive observation
- **WHEN** the user selects one app and grants proactive observation
- **THEN** a memory-only grant binds that app's bundle id, local PID/process
      generation, and verified signing identity for at most 15 minutes
- **AND** a visible scope indicator with Pause and Stop remains present

#### Scenario: Scoped process exits or identity changes
- **WHEN** the process exits, is replaced, reuses a PID, or no longer matches the
      verified signing identity
- **THEN** the observation grant is revoked before another AX event is accepted

### Requirement: Observation and optional visual context use public APIs
The macOS surface SHALL use public `AXUIElement` and `AXObserver` APIs for
semantic context and SHALL offer an independently enabled public
ScreenCaptureKit focused-window attachment. It SHALL NOT use synthetic input,
Apple Events, or private frameworks.

#### Scenario: Scoped app changes
- **WHEN** a relevant AX notification occurs inside the active grant
- **THEN** the app may update a bounded semantic snapshot
- **AND** no ungranted pixel capture or whole-desktop polling occurs

#### Scenario: User enables visual context
- **WHEN** the user explicitly enables screenshots for the active one-app grant
- **THEN** only the same verified process's focused window may be captured
- **AND** the window identity is revalidated before and after capture
- **AND** the re-encoded JPEG is at most 1 MiB with longest edge at most 1280

#### Scenario: Screenshot option remains off
- **WHEN** an AX observation grant is active without screenshot authority
- **THEN** no ScreenCaptureKit enumeration or capture occurs

### Requirement: AX context is bounded and redacted locally
The macOS surface SHALL suppress secure/sensitive windows and SHALL apply node,
depth, string, byte, and lifetime limits before context can be previewed.

#### Scenario: Secure field is present
- **WHEN** a snapshot encounters secure text or credential/payment metadata
- **THEN** that subtree/value is excluded locally
- **AND** no override can release it in v1

#### Scenario: Snapshot reaches a hard bound
- **WHEN** the tree exceeds 128 nodes, depth 8, 256 characters per label, or
      16 KiB outbound context
- **THEN** traversal/output is deterministically truncated with local counts

### Requirement: Network release mode is explicit
The macOS surface SHALL expose `local_only`, `ask_each_time`, and
`trusted_server_15m` modes. It SHALL contain no packaged gateway destination and
SHALL contact only the canonical user-configured Chief Moa origin while a
matching network release grant is active.

#### Scenario: Local or ask-each-time grant expires without acceptance
- **WHEN** a local-only or ask-each-time grant expires or the user dismisses it
- **THEN** all AX references and derived context are purged
- **AND** zero network requests have occurred

#### Scenario: User grants trusted-server release
- **WHEN** the user confirms the exact gateway origin, evidence classes,
      screenshot state, and expiry
- **THEN** bounded event-driven context may be released to that origin until the
      grant expires or is revoked
- **AND** no other host, redirect destination, analytics, or update endpoint is
      contacted

#### Scenario: Trusted-server grant is revoked
- **WHEN** Stop, expiry, app/process identity change, permission loss, sleep,
      lock, or destination change occurs
- **THEN** queued observations are invalidated before another request is sent

### Requirement: Outbound AX context matches an exact request preview
In ask-each-time mode no AX or screenshot context SHALL leave the Mac until the
user approves the immutable serialized/redacted body, HTTP method, full
canonical HTTPS URL including path, selected headers/content type, and redirect
policy. Trusted-server mode SHALL bind the same request schema and destination
to its visible time-bounded release grant.

#### Scenario: Destination or payload changes after preview
- **WHEN** any previewed byte, method, full URL, selected header, or redirect
      policy changes
- **THEN** approval is invalidated
- **AND** a fresh preview is required

#### Scenario: Approved endpoint redirects
- **WHEN** the approved request receives a redirect response
- **THEN** the client rejects it without forwarding the body
- **AND** a new destination requires a fresh preview and approval

### Requirement: Native actions are inert proposals until locally approved
Every model-originated native UI action SHALL match a closed local semantic
manifest, current snapshot/state digest, surface identity, and <=30-second
expiry, and SHALL require confirmation in v1.

Each proposal id/nonce SHALL be atomically consumed before mutation and SHALL be
one-shot even while its snapshot and expiry remain current.

#### Scenario: Proposal is stale, unknown, or targets secure state
- **WHEN** validation detects stale state, an unknown action, wrong surface, or
      a secure/non-settable value
- **THEN** the action is rejected without AX mutation

#### Scenario: Confirmed proposal remains valid
- **WHEN** a supported proposal still matches its bound target and state
- **THEN** execution uses only a public AX action or checked value setter
- **AND** no coordinate/private/synthetic fallback runs

#### Scenario: Confirmed proposal is replayed
- **WHEN** a consumed proposal id/nonce is submitted again
- **THEN** it is rejected without AX mutation

### Requirement: Local receipts precede optional sync
The macOS surface SHALL atomically durably commit/fsync a bounded pending receipt
before execution and a terminal receipt afterward, linked to the previous
receipt hash. If the pending commit fails, execution SHALL NOT occur. Gateway
receipt sync SHALL be default-off and separately disclosed/bound in approval.

#### Scenario: Action process crashes after pending write
- **WHEN** the app restarts with a pending receipt lacking a terminal result
- **THEN** it records/reports an interrupted outcome without replaying the action
- **AND** raw AX labels, values, or trees are absent from receipt storage

### Requirement: Browser work crosses a typed product boundary
The macOS surface SHALL treat the browser extension as a separate product and
SHALL delegate explicit browser work only to an online device client that
advertises the requested browser-local tool.

#### Scenario: User opens a URL in a connected browser
- **WHEN** the user enters a complete HTTP or HTTPS URL and selects an online
      browser extension advertising `browser.tab.open`
- **THEN** the Mac app queues a typed request bound to that device through the
      authenticated gateway tool-request hub
- **AND** the delegated tab opens in the background without taking focus
- **AND** the Mac app shows queued, running, and terminal state from its bounded
      source-device request stream
- **AND** the extension retains sole authority over Chrome execution and its
      receipt

#### Scenario: No compatible browser is online
- **WHEN** no online browser extension advertises `browser.tab.open`
- **THEN** the Mac app reports that no compatible extension is available
- **AND** it does not fall back to Accessibility, synthetic input, or direct
      Chrome control

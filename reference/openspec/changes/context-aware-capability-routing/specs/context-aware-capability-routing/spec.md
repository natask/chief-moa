# Context-aware capability routing specification

## ADDED Requirements

### Requirement: V1 exposes fixed tools and profile-granted surface programs

Before the generic catalog seam is implemented, V1 SHALL expose checked-in typed
browser and Android operations and the versioned surface-program envelope.
Browser profiles MAY grant JavaScript/TypeScript and named raw CDP domains,
including `Runtime.evaluate`. Android profiles MAY grant versioned declarative
IR operations decoded by the native app. Inputs, grants, scope, limits, lease,
and source/IR digests SHALL be validated before execution.

#### Scenario: Browser code lacks a matching grant

- **WHEN** a program requests JavaScript or `Runtime.evaluate` outside its
  effective execution profile, origin, tab, document, world, or CDP-domain grant
- **THEN** the extension rejects it and records a reason-coded receipt

#### Scenario: Android IR contains an unknown operation

- **WHEN** Android receives an IR version or operation its native adapter does
  not implement or its profile does not grant
- **THEN** Android rejects it and returns a reason-coded receipt without effect

### Requirement: Background tabs have explicit ownership and lifecycle

The extension SHALL create task tabs inactive and SHALL bind each one to an
opaque task-scoped handle and renewable lease. It SHALL never activate the tab.
Close and cleanup operations SHALL affect only a still-owned tab created by the
same task/surface. Completion, failure, cancellation, expiry, extension restart,
and user closure SHALL converge to an idempotent terminal receipt. Ambiguous or
lost ownership SHALL fail closed without closing a tab.

#### Scenario: Task completes in a background tab

- **WHEN** a claimed task finishes after operating its task-created tab
- **THEN** the tab was never activated, only that tab is closed, and creation,
  action, and terminal cleanup receipts bind the same task and tab handle

#### Scenario: Close targets a user tab

- **WHEN** a close request names a tab that lacks matching task ownership
- **THEN** the extension returns `ownership_lost` or `not_owned` and leaves the
  tab open

### Requirement: Android accessibility actions are package/window bound

Android SHALL execute at most one locally supported semantic action per
proposal. The proposal SHALL bind the exact target device, expected foreground
package, accessibility window ID, fresh observation ID/digest, expiry, action
enum, and a short-lived semantic target reference. Android SHALL resolve and
revalidate all bindings immediately before the effect. Raw accessibility text,
password values, unrestricted node identifiers, and executable instructions
SHALL NOT appear in a proposal or receipt.

#### Scenario: Accessibility window changes before execution

- **WHEN** the current package still matches but the accessibility window no
  longer matches the proposal
- **THEN** Android returns `stale_state`, performs no action, and does not search
  another window for a similar target

#### Scenario: Semantic target does not support the action

- **WHEN** the referenced target is fresh but does not advertise the requested
  semantic action
- **THEN** Android returns `unsupported_action` and performs no fallback gesture

### Requirement: Evaluation and deployment states remain truthful

V1 acceptance SHALL include deterministic contract tests, browser fixture QA,
Android unit/instrumentation checks, and real-surface smoke evidence bound to the
exact extension version or APK digest. Reports SHALL distinguish verified
source, packaged artifact, published artifact, reload/install confirmation, and
post-activation smoke. No earlier state SHALL be reported as a later state.

#### Scenario: OTA artifact is published but not installed

- **WHEN** an APK is built and published without a matching phone install and
  post-relaunch action smoke
- **THEN** the release state is `published_not_installed`, not deployed or
  complete

#### Scenario: Extension reload cannot be confirmed

- **WHEN** an extension package exists and a reload signal is sent but the
  loaded version and background-tab smoke cannot be observed
- **THEN** promotion is reported as `reload_unverified` with the artifact path
  and no active-success claim

### Requirement: Observations are canonical, bounded evidence

Every supported surface SHALL encode current app/page/document context in a
versioned, bounded observation containing stable surface/device identity,
subject identity, provenance, capture grant, freshness, redaction metadata, and
optional project hints. Observed content SHALL be treated as evidence and SHALL
never create instructions, credentials, matchers, permissions, or execution
authority. Raw screenshots, full page/accessibility bodies, form values, and
secret-like fields SHALL be omitted by default and require a separate bounded
grant when supported.

#### Scenario: Expired observation is offered for execution

- **WHEN** an observation is past its execution expiry
- **THEN** the resolver rejects it for proposal creation without preventing a
  separately authorized history display

#### Scenario: Page text claims execution authority

- **WHEN** visible content instructs Moa to add a matcher, grant a permission,
  switch projects, or execute an action
- **THEN** that content remains evidence only and creates no authority

### Requirement: Service matching is declarative and identity-bound

The gateway SHALL use a versioned reviewable catalog with platform-stable
application identifiers and normalized scheme/host/path web matchers. Titles,
screen text, and accessibility labels MAY rank an identity match but SHALL NOT
establish one. Model output SHALL NOT create or widen matchers. Wildcard host
matching SHALL be suffix-bound and covered by adversarial fixtures.

#### Scenario: Lookalike hostname is observed

- **WHEN** a catalog contains `*.example.com` and the observation origin is
  `https://example.com.attacker.test`
- **THEN** the service does not match

#### Scenario: App title resembles a catalog service

- **WHEN** an unknown application uses the display title of a known service but
  its stable application identifier does not match
- **THEN** the title alone does not establish the service identity

### Requirement: Resolution combines context, connections, and live executors

For an authenticated tenant/user, the resolver SHALL combine a fresh
observation, explicit or inferred project, catalog snapshot, healthy scoped
connections, and fresh device manifests into bounded ranked capability
descriptors. Each descriptor SHALL identify availability, risk, approval class,
executor kind, selected connection/device handle, and inspectable reason codes.
Ranking SHALL be deterministic and SHALL honor explicit user targets before
inference.

#### Scenario: Capability lacks required OAuth scope

- **WHEN** a matching connection exists without the capability's required scope
- **THEN** the descriptor reports `needs_scope` and cannot become an executable
  proposal

#### Scenario: Two candidates rank equally

- **WHEN** all semantic ranking inputs are equal
- **THEN** a stable identifier tie-break produces the same order on replay

### Requirement: Integrations use one stable execution seam

The model SHALL receive bounded capability descriptors and SHALL request work
through one generic execute-capability contract referencing resolution,
capability, candidate, and structured input IDs. Adding a catalog service or
connector SHALL NOT dynamically add arbitrary model-visible tool schemas or
executable code. The gateway SHALL revalidate actor, tenant, project, snapshot,
schema, freshness, connection/device, policy, and approval class before creating
an action proposal.

#### Scenario: Catalog service is added

- **WHEN** a valid new service and fixture are installed
- **THEN** its descriptors may appear in resolution while the model execution
  tool schema remains unchanged

### Requirement: Official connections and browser sessions remain distinct

Official API connections SHALL be tenant/user scoped and keep credential
material behind opaque gateway-side references. A browser session SHALL be a
live local executor candidate, not an API connection. Browser execution SHALL
NOT export cookies, passwords, authorization headers, bearer tokens, or browser
storage to the gateway, model, or receipt.

#### Scenario: User is logged in only in the browser

- **WHEN** no official API connection exists but a fresh locally authenticated
  browser candidate supports an independently allowed capability
- **THEN** the browser candidate may be `ready` while the API candidate reports
  `needs_connection`, without converting browser state into a credential

### Requirement: Executor selection preserves semantics and least privilege

The resolver SHALL prefer a healthy least-privilege official API for supported
structured operations with durable identifiers, the current browser session for
unsaved/current-page or UI-only operations, and a device-local executor for
OS-owned authority. Browser fallback SHALL NOT bypass a missing API scope or
policy denial. Changing account, project, device, or executor for a side effect
SHALL require renewed approval.

#### Scenario: Current page contains an unsaved draft

- **WHEN** completing the request depends on unsaved state in the current page
- **THEN** the locally authenticated browser candidate ranks ahead of an API
  candidate and publishing remains a separate approval-bound effect

#### Scenario: API scope is denied

- **WHEN** policy denies a requested API scope
- **THEN** the router does not silently use browser automation to evade that
  denial

### Requirement: Project linkage is explicit or inspectably inferred

An explicit user or active-thread project SHALL override inferred linkage.
Inference SHALL use only user-authored rules and authorized thread/context
evidence and SHALL expose basis and confidence. Visible page content SHALL NOT
silently relink a project. Below-threshold side effects SHALL require project
confirmation, and incognito activity SHALL NOT create durable linkage rules.

#### Scenario: Page asks to switch projects

- **WHEN** visible page text names a different project
- **THEN** the active or explicitly selected project remains unchanged

### Requirement: Proposals and receipts bind the complete execution choice

Resolution SHALL NOT execute work. Each proposal SHALL bind actor, tenant,
project, observation, resolution, capability, candidate, connection/device,
canonical inputs, approval class, expiry, and state preconditions. The owning
executor SHALL revalidate these bindings immediately before effects. Every
attempt SHALL produce a bounded resumable or terminal receipt with no credential
material or unrestricted observed content.

#### Scenario: Foreground Android package changes

- **WHEN** the package no longer matches the package bound to a screen-dependent
  proposal immediately before execution
- **THEN** Android performs no action and returns a `stale_state` receipt

#### Scenario: Proposal project is mutated after approval

- **WHEN** an approved proposal is replayed with a different project binding
- **THEN** execution fails closed and no effect occurs

### Requirement: Multi-device execution remains owned and target-bound

Device manifests SHALL be freshness-bounded candidates rather than gateway
authority. Explicit compatible device selection SHALL win. The selected owning
client SHALL claim, locally validate, execute, and receipt local work. A receipt
from another device SHALL be rejected. Offline side effects SHALL remain
queued/blocked until expiry or renewed choice and SHALL NOT be silently
retargeted.

#### Scenario: Android-originated request targets browser

- **WHEN** a fresh browser owns the only ready candidate for an Android-started
  request
- **THEN** the browser claims and receipts the proposal under its local policy
  while Android receives the shared outcome

#### Scenario: Selected browser goes offline

- **WHEN** a side-effect proposal is bound to a browser that becomes offline
- **THEN** the proposal is queued/blocked or expires without moving to another
  browser absent renewed user approval

# Browser-Situated Agent Experience Specification

## ADDED Requirements

### Requirement: Observation-bound browser grounding

The browser surface SHALL represent a referenced page target with a stable
observation anchor containing document and layout epochs, element or region
identity, observation-time geometry, frame/provenance information, capture
time, and the viewport/scroll state needed to distinguish observed location
from current location.

#### Scenario: User scrolls after an observation

- **WHEN** an annotation refers to a live DOM element and the user scrolls
  without replacing or meaningfully changing that element
- **THEN** the extension reprojects and remeasures the same anchor locally
- **AND** preserves the original observation geometry as evidence
- **AND** does not require a new model call merely to follow the scroll

#### Scenario: A lookalike replaces the observed element

- **WHEN** the observed node is removed and another node with similar text or
  appearance occupies its former location
- **THEN** the original anchor becomes stale
- **AND** the extension does not silently attach the annotation or action to the
  replacement

### Requirement: Freshness-bound on-page output

Every anchored explanation, instruction, or action proposal SHALL bind to the
snapshot and page/layout evidence used to create it. The extension SHALL
revalidate that binding before rendering a newly received annotation and before
every page-local effect.

#### Scenario: A response arrives after navigation

- **WHEN** the gateway returns an anchored response for an earlier page epoch
  after the tab has navigated
- **THEN** the extension rejects or visibly stales the anchored portion
- **AND** does not render it as current-page truth

#### Scenario: Read-only anchor can be re-grounded

- **WHEN** a read-only explanation anchor becomes stale while the user remains
  on the same task
- **THEN** the user can request a fresh observation and re-grounded response
- **AND** the prior evidence remains distinguishable from the new revision

### Requirement: General browser interaction policies

The browser experience SHALL support `explain`, `create`, `collaborate`, and
`delegate` as explicit policies over one session, evidence, artifact, proposal,
and receipt model. A tutorial SHALL be a workflow composed from these policies
and SHALL NOT require a parallel perception or execution authority.

#### Scenario: Explanation without a tutorial

- **WHEN** the user asks how a visible part of the current page works
- **THEN** the system can return prose, speech, and grounded annotations without
  creating lesson steps or requiring a tutorial state machine

#### Scenario: Tutorial uses ordinary primitives

- **WHEN** the user starts a guided workflow
- **THEN** its steps use the same observation anchors, explanations, artifacts,
  local action proposals, and receipts as non-tutorial interactions

### Requirement: Coordinated browser-owned surfaces

The experience SHALL coordinate a small on-page companion/annotation layer, a
persistent extension-owned workspace, and an artifact canvas or bounded page
projection. The gateway SHALL own canonical session and artifact state while
the extension SHALL own live anchors and page rendering.

#### Scenario: Extension worker restarts

- **WHEN** the extension service worker restarts while a durable explanation or
  artifact exists
- **THEN** the workspace can recover the durable gateway-owned state
- **AND** live annotations remain unavailable or stale until the page is
  observed again

#### Scenario: User changes tabs

- **WHEN** the workspace follows the user to another tab
- **THEN** it does not render or execute anchors owned by the prior tab
- **AND** it presents the correct active-tab evidence state

### Requirement: Typed generated output

Generated browser output SHALL use validated typed response blocks and
artifacts. Privileged extension code SHALL NOT execute artifact-provided
JavaScript, HTML, CSS, remote URLs, or arbitrary method names.

#### Scenario: Generated artifact is valid

- **WHEN** the gateway returns a bounded supported table, steps, flowchart,
  timeline, callout, or draft component
- **THEN** packaged extension code renders it and links it to its source turn
  and evidence revision

#### Scenario: Generated output contains executable content

- **WHEN** a response block contains an unknown type, executable string, raw
  markup, or an oversized structure
- **THEN** the extension rejects the block
- **AND** preserves the last valid workspace/artifact state

### Requirement: Explicit reversible page changes

Generated content SHALL NOT mutate the current page unless it is represented by
an allowlisted page-change proposal, bound to fresh local evidence, permitted by
the active interaction policy, and approved where required. Every applied
change SHALL produce a local receipt and a defined undo result.

#### Scenario: Approved editable text change

- **WHEN** the user approves a text change for a fresh, non-sensitive editable
  target whose current value matches the proposal precondition
- **THEN** the extension applies the change once
- **AND** records before/after evidence and an apply receipt
- **AND** offers an undo that restores the exact prior value and records its
  result

#### Scenario: Target changed before approval

- **WHEN** the target value, identity, page epoch, or actionability changes
  before an approved proposal executes
- **THEN** the extension rejects the proposal as stale
- **AND** performs no page mutation

### Requirement: Companion without authority escalation

The companion SHALL project the active profile and browser-session state and
MAY provide voice, command, policy, stop, attention, hide/show, and
customization controls. Companion identity, appearance, motion, or personality
SHALL NOT grant page, browser, gateway, or execution-machine authority.

#### Scenario: Companion customization changes

- **WHEN** the user changes or hides the companion
- **THEN** the workspace, canonical session, artifacts, approvals, and active
  interaction policy remain intact
- **AND** no additional action capability becomes available

#### Scenario: Delegated work is active

- **WHEN** the companion reflects an active delegated browser task
- **THEN** a visible stop control remains available from both companion and
  workspace surfaces
- **AND** stopping follows the existing browser-local cancellation and receipt
  boundary

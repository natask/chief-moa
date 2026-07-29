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

### Requirement: Explicit turns include visual and semantic evidence

An explicit browser-agent turn SHALL send one bounded current-viewport JPEG
alongside the bounded semantic page projection to the user's configured
gateway. The gateway SHALL provide both evidence classes to the reasoning model
when available. Page pixels and DOM content SHALL remain untrusted evidence and
SHALL NOT expand the selected agent, delegation envelope, approval policy, or
local execution authority.

#### Scenario: User asks for help with the visible page

- **WHEN** the user explicitly submits a browser-agent turn on an ordinary page
- **THEN** the extension captures the current viewport and semantic page context
- **AND** the gateway reasons over both representations
- **AND** any page effect still requires the existing browser-owned validation,
  approval, execution, and receipt path

#### Scenario: Page has no useful DOM text

- **WHEN** an explicit turn targets a canvas-heavy or otherwise visually
  rendered page with no extractable semantic text
- **THEN** a valid bounded JPEG is sufficient evidence to answer the turn
- **AND** the absence of DOM text does not cause the gateway to discard the
  visual evidence

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

### Requirement: Separately addressable browser agents

The browser experience SHALL present Explain, Help, Collaborate, and Delegate as
separately user-addressable agents over one session, evidence, artifact,
proposal, run, and receipt model. The active agent SHALL be visible and carried
as typed data rather than inferred from generated prose. Creating content SHALL
be an output capability rather than a fifth authority class. A tutorial SHALL
be a workflow composed from these agents and SHALL NOT require parallel
perception or execution authority.

#### Scenario: Explanation without a tutorial

- **WHEN** the user asks how a visible part of the current page works
- **THEN** the system can return prose, speech, and grounded annotations without
  creating lesson steps or requiring a tutorial state machine
- **AND** it performs no page action

#### Scenario: User asks the Help agent

- **WHEN** the user selects Help and asks what to do next
- **THEN** the system may explain, draft, and propose the next step
- **AND** the user remains the actor on the page

#### Scenario: User collaborates on one action

- **WHEN** the user selects Collaborate and confirms a fresh action proposal
- **THEN** the browser may execute that one locally validated action
- **AND** it returns control and the action receipt before proposing another

#### Scenario: Tutorial uses ordinary primitives

- **WHEN** the user starts a guided workflow
- **THEN** its steps use the same observation anchors, explanations, artifacts,
  local action proposals, and receipts as non-tutorial interactions

### Requirement: Authority-safe agent routing

Direct user agent selection SHALL control routing. Inferred intent or gateway
recommendation SHALL NOT escalate a turn or run into an agent with greater
action authority. Every proposal, approval, run, and receipt SHALL retain the
typed selected-agent identity.

#### Scenario: Ambiguous action request

- **WHEN** a request could mean Help, Collaborate, or Delegate and the user has
  not explicitly selected one
- **THEN** the browser remains read-only and asks the user to choose
- **AND** does not start a delegated run or execute an action

#### Scenario: Gateway recommends delegation

- **WHEN** the active agent is Explain, Help, or Collaborate and the gateway
  recommends Delegate
- **THEN** the recommendation is presented as a choice
- **AND** Delegate authority begins only after explicit user selection and a
  confirmed delegation envelope

### Requirement: Bounded delegated browser work

Delegate SHALL be the primary outcome-oriented browser agent. A delegated run
SHALL start only from a submission-authorized envelope containing a goal, browser
scope, allowed action classes, approval policy, checkpoints, stop conditions,
and required completion evidence. The browser SHALL intersect the envelope
with packaged allowlists, current permissions, and fresh page evidence before
each local effect.

#### Scenario: User submits delegated intent
- **WHEN** the user sends an imperative request routed to Delegate
- **THEN** the browser starts the bounded run without asking whether to delegate
- **AND** derives its action classes and page/origin scope from the request and current page context
- **AND** does not acquire unrelated capabilities

#### Scenario: Delegated task uses preauthorized actions

- **WHEN** a confirmed envelope preauthorizes supported action classes and the
  next action is within scope with fresh evidence
- **THEN** Delegate may execute the action without a redundant per-step prompt
- **AND** records a local receipt and visible run progress

#### Scenario: Delegated task reaches a checkpoint

- **WHEN** the next action is outside the envelope, belongs to an always-ask
  class, changes origin/scope, or reaches a declared checkpoint
- **THEN** the run pauses before the effect
- **AND** shows the decision or approval needed to continue

#### Scenario: Delegated task reports success

- **WHEN** Delegate claims the goal is complete
- **THEN** the run includes the envelope's required completion evidence and
  receipts for applied actions
- **AND** otherwise reports blocked, canceled, or failed rather than success

#### Scenario: User stops delegated work

- **WHEN** the user activates stop from the companion or workspace
- **THEN** no new browser-local action begins
- **AND** completed action receipts remain visible
- **AND** any in-flight outcome is reported honestly

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

### Requirement: Packaged helpers and generated programs use distinct effect lanes

The browser SHALL distinguish packaged page-change helpers from arbitrary
generated page programs. A packaged helper SHALL use an allowlisted proposal,
fresh local evidence and preconditions, active-agent and delegation policy, and
approval where required; every applied helper SHALL produce a local receipt and
a defined undo result. A generated program SHALL instead use
`moa.browser-program.v2` under its selected execution profile and exact local
authority. Every program attempt SHALL produce a local effect receipt, but
SHALL report cleanup/rollback as supported, unavailable, attempted, succeeded,
or failed rather than claiming arbitrary mutation is universally reversible.
Deleting application data SHALL remain a destructive application action even
when JavaScript performs it and SHALL NOT travel through a visual/page-helper
effect class.

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

#### Scenario: Authorized program has no complete inverse

- **WHEN** an authorized generated program applies a page effect but declares no
  complete cleanup or inverse revision
- **THEN** the receipt records that rollback is unavailable
- **AND** packaged stop prevents new executions without claiming to reverse the
  completed effect

#### Scenario: Program attempts destructive application deletion

- **WHEN** generated JavaScript would delete an application record rather than
  hide, detach, restyle, insert, or annotate page presentation
- **THEN** the browser routes it through the destructive application-action
  policy and approval lane
- **AND** rejects visual-modification authority as insufficient

### Requirement: Companion without authority escalation

The companion SHALL project the active profile and browser-session state and
MAY provide voice, command, active-agent selection, stop, attention, hide/show, and
customization controls. Companion identity, appearance, motion, or personality
SHALL NOT grant page, browser, gateway, or execution-machine authority.

#### Scenario: Companion customization changes

- **WHEN** the user changes or hides the companion
- **THEN** the workspace, canonical session, artifacts, approvals, and active
  agent remain intact
- **AND** no additional action capability becomes available

#### Scenario: Delegated work is active

- **WHEN** the companion reflects an active delegated browser task
- **THEN** a visible stop control remains available from both companion and
  workspace surfaces
- **AND** stopping follows the existing browser-local cancellation and receipt
  boundary

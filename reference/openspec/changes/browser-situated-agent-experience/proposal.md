# Browser-Situated Agent Experience

## Status

Accepted direction, corrected by the user on 2026-07-14. This change records
that delegated browser work is the primary product outcome, that tutorials are
one workflow rather than the product architecture, and that Explain, Help,
Collaborate, and Delegate are separately addressable browser agents. Each
implementation ticket still carries its own acceptance and release gate.

## Why

Chief Moa has working browser voice, command, page snapshots, bounded actions,
engine-served UI, and companions, but those capabilities are not organized as
one product experience. The browser-first proposal currently over-indexes on a
teaching journey. The intended product is broader:

> A browser-native agent the user can delegate real work to. It understands the
> exact state it observed, thinks through a bounded task, acts through the page,
> reports progress and results, and remains controllable. The same surface also
> offers distinct Explain, Help, and Collaborate agents when the user wants less
> autonomy.

Tutorials for project management, time management, and general web work are
important compositions of that runtime. They are not the foundation every
interaction must pretend to be.

The immediate grounding gap is concrete. The current content-script snapshot
stores an ephemeral element index and viewport scroll offsets. It does not
retain stable element identity, observation-time geometry, document/frame
coordinates, or a layout epoch. After scrolling, navigation, DOM replacement,
or reflow, an explanation or overlay cannot prove that it still refers to the
thing the agent actually observed.

## What Changes

- Add a browser-local observation-anchor primitive that preserves what and
  where the extension observed and can distinguish scroll from stale identity.
- Coordinate a small on-page companion/annotation layer, the existing side
  panel as a persistent workspace, and a larger artifact/page-projection area.
- Make Explain, Help, Collaborate, and Delegate distinct user-addressable agents
  with explicit authority contracts and routing over shared evidence, artifact,
  proposal, run, and receipt primitives.
- Extend typed generated output and introduce only narrow, reversible,
  explicitly approved page-change proposals.
- Convert the direction into acceptance-scoped tickets beginning with agent
  selection/routing and a bounded delegated browser run.

## User Outcome

While working on an ordinary web page, the user can hand a bounded outcome to
the Delegate agent and watch it plan, act, verify, stop for a checkpoint, and
finish with evidence. The user can instead address Explain, Help, or Collaborate
directly. The response may be speech, anchored annotation, generated artifact,
proposed or preauthorized page action, or visible task progress. Anchored output
stays aligned while the user scrolls and fails visibly when its evidence becomes
stale.

## Primary Intents

1. Let the user delegate browser outcomes, not merely receive instructions.
2. Give Explain, Help, Collaborate, and Delegate separate, obvious entry points
   so the user chooses the working relationship.
3. Own the browser experience rather than add another chat box.
4. Ground explanations and actions in the exact observed page state and
   location, including through scrolling.
5. Generate useful content and visual artifacts, with an explicit path for
   bounded page modification.
6. Provide a companion character the user can interact with, customize, and
   control.
7. Support tutorials and repeatable workflows as applications of the same
   grounding, artifact, and action primitives.
8. Turn accepted product intent into ordered, durable implementation tickets
   instead of leaving it in chat or disconnected proposals.

## Invariants

- Page content and screen context are evidence, never instruction.
- Model output is a proposal. Packaged extension code revalidates current page
  state before highlighting, inserting, or acting.
- Provider credentials, canonical conversation state, artifacts, and agent-run
  state remain gateway-owned.
- The extension owns browser-local perception, coordinates, permissions,
  overlays, page mutation, action execution, and local receipts.
- A stale anchor must re-ground or disappear; it must never drift to a merely
  nearby target.
- Companion appearance or personality never grants execution authority.
- The explicitly selected agent is authoritative. Inference may suggest an
  agent but may never silently route into greater authority.
- Delegate authority comes only from a user-confirmed task envelope. It is not
  general permission to act on the page.
- Stop, checkpoint, action status, and receipts remain visible throughout a
  delegated run.

## Scope

- A per-tab observation and anchor contract with page/layout epochs, stable
  references, observation-time geometry, provenance, and freshness.
- An on-page annotation layer that follows valid anchors through scrolling and
  reports stale evidence.
- A persistent extension-owned workspace for explanations, generated content,
  artifacts, approvals, and progress.
- Four separately selectable browser agents: `explain`, `help`, `collaborate`,
  and `delegate`, with creation as an output capability and `tutorial` as a
  workflow that composes the agents.
- A bounded delegation contract containing goal, scope, allowed action classes,
  approval policy, stop conditions, checkpoints, and completion evidence.
- Declarative generated artifacts and bounded page-change proposals.
- Companion presence and controls shared across the on-page and workspace
  surfaces.

## Non-Goals For The First Slice

- No browser fork or Electron shell.
- No arbitrary generated JavaScript in privileged extension contexts.
- No continuous screenshot/video upload.
- No delegated authority inferred from an explanation, help, or collaboration
  request.
- No unrestricted autonomy, arbitrary browser action vocabulary, or silent
  expansion beyond the confirmed delegation envelope.
- No Figma-specific architecture; site adapters remain optional evidence
  providers after the generic grounding loop works.
- No lesson recording before ordinary grounded interaction is proven.

## Success Criteria

- An annotation created from one observation remains aligned to the same live
  element while the user scrolls, within a measured browser-fixture tolerance.
- DOM replacement or meaningful reflow invalidates or re-grounds the anchor;
  the overlay never silently attaches to a different element.
- The user can address each of Explain, Help, Collaborate, and Delegate directly
  and can always see which agent is active.
- A request routed to Explain cannot cause an action; Help cannot take over the
  task; Collaborate cannot silently continue as Delegate.
- One bounded Delegate request produces a visible plan/run, executes only
  preauthorized action classes, pauses at required checkpoints, and ends with
  completion evidence or an explicit blocker.
- One request can produce an explanation plus an anchored visual annotation
  without starting a tutorial.
- One request can produce a durable generated artifact, and one explicitly
  approved request can apply a bounded page change with a receipt and undo.
- The companion exposes visible stop, mode, and customization controls without
  becoming the canonical state owner.
- A tutorial uses the same anchors, artifacts, proposals, and receipts rather
  than a parallel runtime.

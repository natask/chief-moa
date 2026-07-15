# Browser-Situated Agent Experience

## Status

Proposed for product and architecture alignment. This change records the
2026-07-14 correction that tutorials are one workflow, not the product
architecture. It does not authorize implementation, packaging, or deployment
until the user aligns with the design.

## Why

Chief Moa has working browser voice, command, page snapshots, bounded actions,
engine-served UI, and companions, but those capabilities are not organized as
one product experience. The browser-first proposal currently over-indexes on a
teaching journey. The intended product is broader:

> A browser-native companion that understands the exact state it observed,
> explains and creates in context, can propose changes to the page, and remains
> controllable and customizable by the user.

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
- Make explanation, creation, collaboration, and delegation explicit policies
  over shared evidence and authority; express tutorials as workflows over them.
- Extend typed generated output and introduce only narrow, reversible,
  explicitly approved page-change proposals.
- Convert the direction into acceptance-scoped tickets beginning with a
  read-only grounded explanation slice.

## User Outcome

While working on an ordinary web page, the user can ask the companion to
explain, generate, collaborate, act, or start a guided workflow. The response
may be speech, anchored annotation, generated artifact, proposed page change,
or visible task progress. Anchored output stays aligned while the user scrolls
and fails visibly when its evidence becomes stale.

## Primary Intents

1. Own the browser experience rather than add another chat box.
2. Ground explanations and actions in the exact observed page state and
   location, including through scrolling.
3. Generate useful content and visual artifacts, with an explicit path for
   bounded page modification.
4. Provide a companion character the user can interact with, customize, and
   control.
5. Support tutorials and repeatable workflows as applications of the same
   grounding, artifact, and action primitives.
6. Turn accepted product intent into ordered, durable implementation tickets
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

## Scope

- A per-tab observation and anchor contract with page/layout epochs, stable
  references, observation-time geometry, provenance, and freshness.
- An on-page annotation layer that follows valid anchors through scrolling and
  reports stale evidence.
- A persistent extension-owned workspace for explanations, generated content,
  artifacts, approvals, and progress.
- General interaction policies: `explain`, `create`, `collaborate`, `delegate`,
  with `tutorial` as a workflow that composes them.
- Declarative generated artifacts and bounded page-change proposals.
- Companion presence and controls shared across the on-page and workspace
  surfaces.

## Non-Goals For The First Slice

- No browser fork or Electron shell.
- No arbitrary generated JavaScript in privileged extension contexts.
- No continuous screenshot/video upload.
- No autonomous page mutation inferred from an explanation request.
- No Figma-specific architecture; site adapters remain optional evidence
  providers after the generic grounding loop works.
- No lesson recording before ordinary grounded interaction is proven.

## Success Criteria

- An annotation created from one observation remains aligned to the same live
  element while the user scrolls, within a measured browser-fixture tolerance.
- DOM replacement or meaningful reflow invalidates or re-grounds the anchor;
  the overlay never silently attaches to a different element.
- One request can produce an explanation plus an anchored visual annotation
  without starting a tutorial.
- One request can produce a durable generated artifact, and one explicitly
  approved request can apply a bounded page change with a receipt and undo.
- The companion exposes visible stop, mode, and customization controls without
  becoming the canonical state owner.
- A tutorial uses the same anchors, artifacts, proposals, and receipts rather
  than a parallel runtime.

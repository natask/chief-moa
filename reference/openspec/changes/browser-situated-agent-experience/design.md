# Design: Browser-Situated Agent Experience

## Intent Resolution

The primary product is a situated browser agent, not a tutorial product. Its
job is to inhabit the work surface: perceive the current state, explain it,
create useful output, point to what it means, and perform only locally approved
changes. Tutorials are saved goal/progress policies over those same primitives.

The first dependency is trustworthy spatial grounding. A polished companion or
artifact canvas built before grounding would still point at stale pixels or
ephemeral snapshot indexes.

## Current Path And Gap

The extension already has the right authority boundary:

```text
content script observes page and executes bounded local actions
  -> background sends bounded evidence to the gateway
  -> gateway reasons and returns text or structured proposals
  -> extension validates and renders/executes locally
```

`content.js::snapshot()` currently returns visible text, an array of visible
interactive elements, a random snapshot ID, viewport dimensions, and current
scroll offsets. The array index is valid only until the next snapshot. No
bounding geometry or stable reference is returned. The side panel is currently
a voice/text conversation surface rather than the persistent workspace, and
Tier A generated UI supports only card/list/map/stat components.

## Considered Shapes

### A. Tutorial-first state machine

Make lesson/step/progress the top-level runtime and express other requests as
short lessons.

This gives a clear initial demo but distorts explanations, content generation,
and direct collaboration. It is retained as a workflow, not selected as the
product architecture.

### B. On-page companion only

Put every response, control, artifact, and action around a floating character.

This maximizes immediacy but recreates the small-overlay bottleneck and leaves
no good home for durable generated output or task state.

### C. Situated browser workspace (selected)

Coordinate three extension-owned surfaces over one grounded session:

1. **Companion and on-page layer:** presence, voice/command entry, exact
   annotations, one current instruction, approval, stop, and immediate result.
2. **Persistent workspace:** explanation, sources/evidence freshness, generated
   content, mode, task/workflow progress, approvals, and artifact list.
3. **Artifact canvas or page projection:** larger editable output; bounded
   approved content may be projected into the current page through the local
   mutation broker.

This preserves immediacy without forcing every product state into the mascot.

## Interaction Policies

These policies share context, artifacts, and receipts; they are not separate
agents or stores.

| Policy | Default authority | Typical output |
| --- | --- | --- |
| `explain` | Read-only | Speech, prose, anchored callout, diagram |
| `create` | Artifact write; page write requires approval | Draft, table, diagram, page-change proposal |
| `collaborate` | One locally validated action at a time | Explanation plus proposed/approved step |
| `delegate` | Explicit bounded task only | Visible multi-step run with stop and receipts |
| `tutorial` | User acts by default | Goal, steps, anchors, predicates, recap |

The gateway may recommend a policy but cannot silently increase authority.

## Observation And Anchor Contract

Each tab owns monotonic `page_epoch` and `layout_epoch` counters.

- `page_epoch` changes on navigation or document identity replacement.
- `layout_epoch` changes on meaningful semantic DOM, frame, viewport, zoom, or
  layout changes. Scroll alone does not invalidate document-space geometry.
- A `MutationObserver`, resize/visual-viewport listeners, and page lifecycle
  events are dirty signals. They are debounced and classified locally; raw
  mutation streams are not sent to the model.

An observed target is returned as an `observation_anchor`:

```json
{
  "anchor_id": "anchor-...",
  "snapshot_id": "snap-...",
  "page_epoch": 4,
  "layout_epoch": 19,
  "frame_path": ["top"],
  "element_ref": {
    "local_id": "el-...",
    "role": "button",
    "name": "Create project",
    "fingerprint": "sha256-..."
  },
  "geometry": {
    "document_rect": { "x": 840, "y": 1480, "width": 132, "height": 36 },
    "viewport_rect_at_observation": { "x": 840, "y": 280, "width": 132, "height": 36 },
    "scroll_at_observation": { "x": 0, "y": 1200 },
    "visual_viewport": { "offset_x": 0, "offset_y": 0, "scale": 1 }
  },
  "captured_at": "...",
  "provenance": "dom"
}
```

The exact schema may use shorter wire names, but it must preserve all semantics
above. Cross-origin frames and canvas regions use different provenance and may
not claim element identity they do not have.

### Reprojection and revalidation

On scroll, the renderer computes a provisional viewport rect from the stored
document rect and current visual viewport. When the live element reference is
available, it remeasures with `getBoundingClientRect()` and uses that as the
authoritative current rect. Before a click, insertion, or step completion, the
extension requires matching page epoch, compatible fingerprint, current
visibility/actionability, and any proposal precondition.

If the node detached, its identity became ambiguous, or a meaningful layout
change invalidated the geometry, the anchor becomes `stale`. Read-only UI may
request a new observation and re-ground. A page action fails closed and asks
for a new proposal.

This distinguishes three facts that the current snapshot collapses:

- where the target was when observed;
- where the same live target is now; and
- whether the product still has evidence that it is the same target.

## Runtime Ownership

| Component | Responsibility | Canonical/local state |
| --- | --- | --- |
| Content-script observation runtime | Epochs, semantic snapshots, element registry, geometry, anchor revalidation | Per-tab ephemeral local state |
| On-page renderer | Companion, annotations, current instruction, approval/stop | Render state only |
| Extension background | Tab/session ownership, gateway transport, proposal routing, artifact cache | Browser-local coordination/cache |
| Side-panel workspace | Explanation, mode, evidence status, generated output, progress | UI projection only |
| Gateway | Reasoning, conversations, goals/workflows, artifacts, proposal records, run state | Canonical durable state |
| Browser mutation broker | Validate current anchor/preconditions, apply allowlisted mutation, undo, receipt | Local mutation/undo record plus gateway receipt |

## Explanation And Generation Flow

```text
user asks from companion or workspace
  -> extension captures bounded snapshot + anchors + provenance
  -> gateway returns response blocks and optional structured proposals
  -> extension checks snapshot/page/layout freshness
  -> workspace renders durable response/artifact
  -> on-page layer renders only currently valid anchored blocks
  -> any page mutation requires explicit policy/approval and a local receipt
```

Response blocks should be typed data: prose, callout, anchor annotation,
table, steps, flowchart, timeline, draft, artifact link, page-change proposal,
approval, or run state. Raw generated HTML/JS/CSS does not enter privileged
extension code.

The first page-change vocabulary should be narrower than arbitrary DOM editing:
insert or replace text in a user-editable field, and apply/revert existing
declarative visual tweaks. Rich generated page components remain artifact
previews until a separate mutation vocabulary and undo contract are approved.

## Companion Contract

The companion is the persistent embodiment of the active gateway profile and
browser session. It may expose voice/command, current policy, stop, attention,
and customization. Its appearance and behavior use the existing companion,
pet, profile, and `avatar_behavior` contracts.

The companion never owns conversation memory, artifacts, or authority. A user
can hide it without stopping the workspace, and stop/delegate controls remain
available in both the companion and workspace.

## Failure Behavior

- Gateway unavailable: preserve last-good workspace/artifacts, label them
  stale, and remove/disable action proposals whose page evidence cannot be
  revalidated.
- Page navigation: increment page epoch and retire all prior page anchors.
- Scroll: reproject and remeasure anchors without a model call.
- DOM/layout change: mark affected anchors dirty, then revalidate or re-ground.
- Restricted page/cross-origin frame/canvas: report the evidence limit; use an
  explicitly captured screenshot/adapter region without claiming DOM identity.
- Extension restart: restore canonical workspace state from the gateway but do
  not restore live anchors until the page is observed again.

## Proposed File Map

| File/component | Responsibility | Expected change |
| --- | --- | --- |
| `browser_extension/extension/page-observation-runtime.js` | Pure epoch, anchor, geometry, and revalidation policy | New focused module, approximately 250-400 lines |
| `browser_extension/extension/content.js` | Compose observation runtime with DOM and on-page UI | Replace ephemeral-only snapshot indexing; keep DOM authority |
| `browser_extension/extension/page-annotation-runtime.js` | Render/reproject anchored callouts and stale state | New focused module, approximately 200-300 lines |
| `browser_extension/extension/sidepanel.html` / `sidepanel.js` | Persistent situated workspace | Extend existing panel, no new UI framework |
| `browser_extension/extension/background.js` or extracted runtime | Route evidence, response blocks, proposals, receipts | Prefer existing extraction pattern |
| Gateway browser-turn runtime | Validate/store typed browser response and proposal envelopes | Extend existing owner, no second browser service |
| Gateway UI/artifact validators | Add bounded teaching/general artifact components | Extend Tier A before Tier B |
| Browser smoke fixtures/scripts | Scroll, reflow, replacement, stale, and approval proof | Isolated Chrome profile only |

Exact gateway files are selected per ticket after inspecting the route touched
by that ticket. The first unit is browser-local and should not require a new
gateway store or route.

## Rollout And Verification

The first units are additive browser behavior behind a default-off development
flag. Verification uses an isolated Chrome-for-Testing profile and dynamic
fixture; it must not reload the user's daily extension during development.

Each deployable unit follows extension verify, smoke, manifest patch bump,
package, reload proof, and active-promotion gating. A package is not proof that
the user's loaded extension reloaded.

## Alignment Decision

Recommended decision: accept the situated browser workspace, make `explain` the
first read-only vertical slice, and implement observation anchors before richer
generation, delegation, tutorials, or companion studio work.

Alignment authorizes the tickets in `tasks.md` one at a time. It does not bulk
authorize later page-mutation vocabularies, Tier B generated UI, recording, or
active deployment.

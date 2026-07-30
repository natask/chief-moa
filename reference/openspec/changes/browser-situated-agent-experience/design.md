# Design: Browser-Situated Agent Experience

## Intent Resolution

The primary product is a situated browser agent for delegated work, not a
tutorial product and not an explanation tool. Its defining outcome is that the
user can hand off a bounded browser task and receive a verified result. Explain,
Help, and Collaborate remain first-class because they represent different
working relationships, not weaker labels hidden inside Delegate. Tutorials are
saved workflows over the same primitives.

The first dependencies are explicit agent routing and trustworthy spatial
grounding. Delegation without the former can silently gain authority;
delegation without the latter acts against stale pixels or ephemeral snapshot
indexes.

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

Page-question evidence also needs a reading/action separation. Reading context
is a bounded semantic projection of the whole currently rendered DOM and must
declare when it is sampled or truncated. The interactive element index remains
limited to the current viewport until the anchor/action contract can revalidate
offscreen targets. Ordinary reading context does not capture pixels. A future
explicit visual-evidence request may capture the verified target tab for
canvas, diagram, cross-origin-frame, or appearance questions, but it is a
separate evidence class and must never be an ambient prerequisite for page
understanding.

### Turn-scoped invocation context

Page evidence belongs to the submitted turn, not to the continuously changing
workspace view. Typed send and final voice submission each form one atomic
boundary: at that boundary the extension resolves the active tab and captures
fresh bounded semantic, visual, page-identity, epoch, and provenance evidence,
then binds those exact evidence references to the outgoing message and any run
created from it. Evidence captured when the composer first opened, recording
started, or an agent was selected is not sufficient for submission.

Navigation after submission changes the live browser state but never rewrites
the submitted turn's invocation context. Responses and durable history can
therefore say which page the turn began from even when the workspace is now
showing another page. Live anchored output and local effects still revalidate
against the current page and fail stale. A later message submitted after the
navigation gets a new current-page snapshot; continuity of agent identity or
session does not reuse the earlier page evidence.

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

## User-Addressable Browser Agents

The browser presents four distinct agents. They share the gateway session,
evidence, artifacts, proposals, runs, and receipts so switching agents does not
fork the user's work. They are separate interaction and authority contracts,
not necessarily four model processes or four stores.

| Agent | Working relationship | Authority | Required visible state |
| --- | --- | --- | --- |
| `explain` | Agent interprets; user decides what to do | Read-only page evidence and artifact output | Active agent, evidence freshness |
| `help` | User leads; agent recommends and prepares the next step | Read-only plus drafts/proposals; user performs page actions | Active agent, suggested next step |
| `collaborate` | User and agent alternate control | One fresh, locally validated action at a time after action-specific confirmation | Active agent, current owner, pending action |
| `delegate` | Agent owns progress toward a confirmed outcome | Multi-step execution only within a confirmed delegation envelope; checkpoints and approvals still apply | Goal, plan, current step, action status, stop, checkpoints, result evidence |

Creation is an output capability available to all four agents, not a fifth
working relationship. A tutorial is a workflow which normally uses Help or
Collaborate and may contain an explicitly delegated subtask.

### Selection and routing

- Direct selection in the UI or an explicit address such as “Delegate this” is
  authoritative.
- A typed or spoken request without a selection may be classified only into an
  equal-or-lower authority contract. If ambiguous, the surface stays read-only
  and asks the user to choose.
- The gateway may recommend another agent. Moving from Explain to Help,
  Collaborate, or Delegate, or from Help/Collaborate to Delegate, requires an
  explicit user choice. No model response can perform that escalation.
- The active agent is carried as a typed field on every turn, proposal, run,
  approval, and receipt. Labels in generated prose have no routing effect.
- A user can downgrade or stop at any time. Downgrading prevents new actions;
  it does not falsify or delete completed receipts.

### Delegation envelope

A Delegate run cannot start until the browser and gateway agree on a bounded
envelope. Submitting an imperative Delegate request is the user's confirmation;
the surface must not ask whether to delegate after the user has already sent it.
The browser derives the smallest useful action-class set from that request and
current page identity rather than granting the full browser action catalog:

```json
{
  "agent": "delegate",
  "goal": "Create the project and add the three supplied tasks",
  "scope": { "tab_ids": [42], "origins": ["https://example.test"] },
  "allowed_action_classes": ["click", "editable_text_change"],
  "approval_policy": {
    "preauthorized": ["click", "editable_text_change"],
    "always_ask": ["submit", "delete", "purchase", "credential"]
  },
  "checkpoints": ["before_external_submit"],
  "stop_conditions": ["goal_complete", "scope_changed", "evidence_stale"],
  "completion_evidence": ["project_identity", "task_count"]
}
```

The shape is illustrative, but every implementation must preserve goal, scope,
action classes, approval policy, checkpoints, stop conditions, and completion
evidence. The local browser policy intersects this envelope with packaged
allowlists and current permissions. An envelope can narrow authority but cannot
grant an action the extension does not already support.

The submitted intent authorizes only what it expresses in context. It does not
authorize unrelated origins, credentials, sensitive/destructive effects, or a
new capability discovered later. Those require a checkpoint or a new request;
the agent must not ask for a second generic delegation confirmation.

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

## Agent Turn And Delegated Run Flow

```text
user explicitly selects or addresses an agent
  -> composer remains live while the user may continue navigating
  -> send/finalized voice submission resolves the then-active page
  -> extension captures and binds bounded snapshot + anchors + provenance
  -> gateway routes the submitted turn under that agent's authority contract
  -> Explain/Help return response blocks and optional non-executable proposals
  -> Collaborate may return one action proposal for confirmation
  -> Delegate creates a bounded run only after envelope confirmation
  -> Delegate returns plan/progress plus actions within the envelope
  -> extension checks snapshot/page/layout freshness
  -> workspace renders durable response/artifact
  -> on-page layer renders only currently valid anchored blocks
  -> local broker intersects agent + envelope + allowlist + current evidence
  -> every page mutation returns a local receipt; checkpoints pause visibly
  -> run ends only with completion evidence, explicit blocker, cancel, or failure
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
browser session. It may expose voice/command, active agent, stop, attention,
and customization. The companion or workspace must make the four agents
separately addressable without hiding the active selection in prose. Appearance
and behavior use the existing companion, pet, profile, and `avatar_behavior`
contracts.

The companion never owns conversation memory, artifacts, or authority. A user
can hide it without stopping the workspace, and stop/delegate controls remain
available in both the companion and workspace.

Starting click-to-speak focuses the visible user composer immediately. The
composer shows its normal blinking caret before transcript text arrives, then
reconciles interim transcript in that same field until final submission. The
companion does not gain a blue listening ring; listening and transcription are
communicated through the focused composer and existing bounded state cues.

## Failure Behavior

- Gateway unavailable: stop any active delegated run before new actions,
  preserve last-good workspace/artifacts, label them
  stale, and remove/disable action proposals whose page evidence cannot be
  revalidated.
- Agent selection ambiguous: remain read-only and request an explicit choice;
  never infer Delegate.
- Delegation scope changes: pause the run, show the mismatch, and require a new
  or narrowed envelope before continuing.
- Page navigation: increment page epoch and retire all prior page anchors.
  Preserve already-submitted turn evidence as invocation history, and bind the
  next submitted turn to a newly captured snapshot of the new page.
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
| `browser_extension/extension/sidepanel.html` / `sidepanel.js` | Persistent workspace plus explicit Explain/Help/Collaborate/Delegate selection | Extend existing panel, no new UI framework |
| `browser_extension/extension/background.js` or extracted runtime | Enforce typed agent routing; route evidence, response blocks, proposals, runs, and receipts | Prefer existing extraction pattern |
| Gateway broker/run contract | Persist active agent and bounded delegation envelope on turns/runs | Extend existing run owner, no second agent service |
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

Decision corrected and accepted from the user's direction: delegated browser
work is primary; Explain, Help, Collaborate, and Delegate are separately
addressable; and creation/tutorials are capabilities/workflows over their shared
runtime. The first coherent vertical slice is explicit agent routing plus one
bounded delegated browser run, built on observation anchors and the existing
allowlisted action broker. It does not authorize unrestricted autonomy, a new
page-mutation vocabulary, Tier B generated UI, recording, or bypassing release
gates.

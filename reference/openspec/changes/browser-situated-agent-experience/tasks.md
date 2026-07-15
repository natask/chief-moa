# Tasks: Browser-Situated Agent Experience

The user corrected and accepted the delegation-first product direction on
2026-07-14. Implement and commit one numbered acceptance unit at a time. This
alignment does not authorize unrestricted actions or bypass verification,
approval, release, or promotion gates.

## 0. Product Alignment

- [x] 0.1 Record delegation as the primary browser outcome and Explain, Help,
      Collaborate, and Delegate as separately addressable agents over shared
      primitives. Creation is an output capability; tutorials are workflows.
- [ ] 0.2 Confirm the three surfaces: small on-page companion/annotation layer,
      persistent side-panel workspace, and large artifact canvas/page
      projection.
- [x] 0.3 Correct the first vertical slice to explicit agent routing plus one
      bounded delegated browser run, built on observation anchors and existing
      allowlisted browser actions.
- [x] 0.4 Align on the userscript-native page runtime in
      `tweeks-inspired-page-runtime-decision.md`: generated evaluation,
      persistent modifications, and page overlays are primary capabilities;
      packaged actions remain convenience helpers and control-plane fallbacks.

Acceptance: the user's correction and unresolved surface choice are recorded
durably rather than silently collapsed into an explanation-first roadmap.

## 1. Explicit Agent Selection And Routing

- [x] 1.0 Add the gateway role contract: selector metadata names Delegate as
      the new-client default, omitted legacy turns remain Explain/read-only,
      and stored browser turns/tasks/runs carry typed role and authority.

Acceptance: deterministic gateway smoke proves only an explicit Delegate turn
with a valid confirmed `moa.browser-delegation.v1` envelope links a browser
task/run; prose-only Delegate returns a non-executable confirmation proposal;
Help and Explain remain read-only; Collaborate returns one non-executable
proposal. Browser voice-session routing is recorded as a follow-up rather than
simulated with a prompt prefix.

- [ ] 1.1 Add four direct browser entry points for Explain, Help, Collaborate,
      and Delegate and carry the selected `agent` as typed data on every browser
      turn.

Acceptance: each agent can be addressed without prompt wording; the active
agent is visible; a deterministic route test proves prose cannot relabel or
escalate the typed selection.

- [ ] 1.2 Enforce the authority matrix at the browser/gateway boundary:
      Explain is read-only, Help prepares but does not act, Collaborate proposes
      one confirmed action at a time, and Delegate can start only from a
      confirmed bounded envelope.

Acceptance: attempts to execute from Explain or Help fail closed; Collaborate
cannot enqueue a second action before the first resolves; ambiguous requests do
not route to Delegate.

Verification:

```sh
cd browser_extension && npm run verify
cd browser_extension && npm run smoke
cd gateway && npm run check
```

## 2. Observation Anchor Primitive

- [ ] 2.1 Add a browser-local observation runtime that assigns page/layout
      epochs and emits stable element refs with observation-time document and
      viewport geometry, scroll/visual-viewport state, provenance, and capture
      time.

Acceptance: an isolated dynamic fixture snapshot contains a complete anchor for
each exposed element, and two snapshots can distinguish the same element after
scroll from a replaced lookalike element.

Verification:

```sh
cd browser_extension && npm run verify
cd browser_extension && npm run smoke
```

- [ ] 2.2 Add deterministic revalidation tests for navigation, scroll, resize,
      zoom/visual viewport, reflow, node replacement, ambiguous identity, and
      cross-origin/canvas limitations.

Acceptance: scroll keeps the anchor valid; navigation and lookalike replacement
make it stale; reflow either remeasures the same node or makes the anchor stale.

## 3. Bounded Delegated Browser Run

- [ ] 3.1 Define and validate a delegation envelope with goal, tab/origin scope,
      allowed action classes, approval policy, checkpoints, stop conditions,
      and completion evidence.

Acceptance: a Delegate run cannot start from prose alone or from an incomplete
envelope; local browser policy can narrow but never expand its authority.

- [ ] 3.2 Execute one fixture task through the existing allowlisted broker with
      a visible plan, current step, stop, checkpoint, action receipts, and final
      completion evidence.

Acceptance: the fixture delegates a multi-step browser outcome, uses only fresh
anchors and preauthorized action classes, stops before any out-of-envelope
action, and finishes as completed, blocked, canceled, or failed—never as an
unreceipted success.

- [ ] 3.3 Prove cancellation and scope-change behavior.

Acceptance: stop prevents any new local action; navigation to an unlisted origin
pauses the run; continuation requires a newly confirmed envelope.

## 4. Grounded On-Page Explanation

- [ ] 4.1 Render one packaged-code annotation bound to a valid anchor and
      reproject it locally during scroll without a gateway/model call.

Acceptance: in the isolated browser fixture, the annotation remains within 2
CSS pixels of the remeasured target through a scripted scroll sequence.

- [ ] 4.2 Fail visibly on stale evidence and support an explicit re-ground
      request.

Acceptance: replacing the target removes/disables the old annotation, labels
the evidence stale, and never attaches it to the replacement before a new
observation is accepted.

- [ ] 4.3 Add a typed read-only browser explanation response containing prose
      plus zero or more anchor annotations.

Acceptance: a deterministic gateway smoke returns one explanation and one
anchor proposal; the extension renders both only when snapshot and epoch
binding match.

## 5. Persistent Browser Workspace

- [ ] 5.1 Turn the existing side panel into a workspace projection with active
      agent, response blocks, evidence freshness, delegated run state, stop,
      checkpoints, and artifact area.

Acceptance: one explanation is visible in the workspace while its valid
annotation appears on-page; changing tabs shows correct ownership and never
reuses an anchor from another tab.

- [ ] 5.2 Persist response/artifact identity through the gateway session while
      keeping live anchors browser-local.

Acceptance: after an extension service-worker restart, the workspace recovers
the durable response but marks annotations unavailable until the page is
observed again.

- [x] 5.3 Make the compact overlay visibly page-grounded and transient: show a
      bounded local title/origin/path identity, retire resolved cue cards on a
      deterministic lifecycle, and expose saved gateway history only on demand.

Acceptance: real headless Chrome shows the fixture page identity and History
affordance; running cues are never retired; a terminal cue retires after the
declared linger or when the next turn begins; History reads the canonical
session endpoint without making the overlay itself a second conversation store.

- [ ] 5.4 Add a monotonic streamed-text and steering-boundary event contract.
      The gateway event envelope must carry `turn_id`, an increasing `sequence`,
      `text_delta`, and cumulative `text_end_char`; completion must declare the
      final character count. The existing `assistant_audio_segment` character
      ranges and client `playback_progress.played_text_char_end` remain the
      speech ledger. Add a canonical steering event/receipt binding the old
      `turn_id`, new turn/message id, boundary sequence, displayed character
      offset, and played character offset.

Acceptance: a deterministic two-turn smoke proves steering freezes accepted old
text, cancels the superseded provider turn without waiting, schedules no old
audio after the boundary, and ignores late old-generation events. The visible
marker is reproduced from canonical offsets after reconnect; reordered,
duplicate, cross-turn, or regressing deltas fail closed. Until these fields
exist, the browser uses its last cumulative `assistant_text` as a local-only
best-effort visual boundary and does not claim a canonical exact splice.

## 6. Generated Content And Artifacts

- [ ] 6.1 Extend Tier A with bounded `table`, `steps`, `flowchart`, `timeline`,
      `callout`, and `draft` response components.

Acceptance: validator and renderer tests reject unknown/oversized data and
render a deterministic artifact without HTML, CSS, JavaScript, or remote URLs.

- [ ] 6.2 Add save, rename, duplicate, and export projections for a gateway-
      owned generated artifact.

Acceptance: a generated artifact survives browser restart and is linked to its
source turn and evidence revision.

## 7. Explicit Page Change

- [ ] 7.1 Add a narrow `editable_text_change` proposal bound to a current
      editable-element anchor, with before value/hash, proposed value, approval,
      apply receipt, and undo receipt.

Acceptance: an approved fixture edit applies once and undo restores the exact
prior value; stale, non-editable, password, or changed-before-apply targets fail
closed.

- [ ] 7.2 Keep declarative visual tweaks on their existing allowlisted path and
      expose both change types in one workspace review history.

Acceptance: the user can distinguish proposed/applied/reverted/rejected state
without reading logs.

## 8. Companion Control

- [ ] 8.1 Project the active companion/profile into the on-page and workspace
      surfaces with visible agent, direct agent selection, stop, hide/show, and
      customization entry.

Acceptance: hiding or changing the companion does not lose workspace state or
change action authority; stop remains reachable from the workspace.

- [ ] 8.2 Bind companion reactions to runtime states using the existing
      declarative `avatar_behavior` contract.

Acceptance: listening/thinking/explaining/waiting/acting/done/error reactions
use known packaged motions only and remain functional with custom appearance.

## 9. Tutorial Workflow

- [ ] 9.1 Define a tutorial as a saved goal, ordered steps, anchor refs,
      completion predicates, correction history, and recap artifact over the
      general situated runtime.

Acceptance: a tutorial can call the same explanation, annotation, artifact,
and approved-action paths; no parallel perception or execution API is added.

## 10. Release Evidence

- [ ] 10.1 Run extension verify/smoke plus the new dynamic-grounding smoke in an
      isolated profile, bump the manifest patch version, and package the unit.
- [ ] 10.2 Reload the user's unpacked extension only when the active-promotion
      gate proves no interruption, and verify the loaded version changed.
- [ ] 10.3 Record any preview/reload blocker with the artifact path.

Acceptance: verification, commit, package, reload status, and post-reload smoke
are recorded as distinct evidence; no step is claimed from an earlier one.

# Tasks: Browser-Situated Agent Experience

No source implementation is authorized until the proposal/design is aligned
with the user. Once aligned, implement and commit one numbered acceptance unit
at a time.

## 0. Product Alignment

- [ ] 0.1 Confirm the situated browser workspace as the product architecture:
      `explain`, `create`, `collaborate`, and `delegate` are general policies;
      tutorials are workflows over the same primitives.
- [ ] 0.2 Confirm the three surfaces: small on-page companion/annotation layer,
      persistent side-panel workspace, and large artifact canvas/page
      projection.
- [ ] 0.3 Confirm the first vertical slice is read-only grounded explanation,
      followed by generated artifacts, then explicitly approved page changes.

Acceptance: the user explicitly accepts or corrects the proposed architecture
and first vertical slice; the decision is recorded here before code changes.

## 1. Observation Anchor Primitive

- [ ] 1.1 Add a browser-local observation runtime that assigns page/layout
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

- [ ] 1.2 Add deterministic revalidation tests for navigation, scroll, resize,
      zoom/visual viewport, reflow, node replacement, ambiguous identity, and
      cross-origin/canvas limitations.

Acceptance: scroll keeps the anchor valid; navigation and lookalike replacement
make it stale; reflow either remeasures the same node or makes the anchor stale.

## 2. Grounded On-Page Explanation

- [ ] 2.1 Render one packaged-code annotation bound to a valid anchor and
      reproject it locally during scroll without a gateway/model call.

Acceptance: in the isolated browser fixture, the annotation remains within 2
CSS pixels of the remeasured target through a scripted scroll sequence.

- [ ] 2.2 Fail visibly on stale evidence and support an explicit re-ground
      request.

Acceptance: replacing the target removes/disables the old annotation, labels
the evidence stale, and never attaches it to the replacement before a new
observation is accepted.

- [ ] 2.3 Add a typed read-only browser explanation response containing prose
      plus zero or more anchor annotations.

Acceptance: a deterministic gateway smoke returns one explanation and one
anchor proposal; the extension renders both only when snapshot and epoch
binding match.

## 3. Persistent Browser Workspace

- [ ] 3.1 Turn the existing side panel into a workspace projection with current
      policy, response blocks, evidence freshness, stop, and artifact area.

Acceptance: one explanation is visible in the workspace while its valid
annotation appears on-page; changing tabs shows correct ownership and never
reuses an anchor from another tab.

- [ ] 3.2 Persist response/artifact identity through the gateway session while
      keeping live anchors browser-local.

Acceptance: after an extension service-worker restart, the workspace recovers
the durable response but marks annotations unavailable until the page is
observed again.

## 4. Generated Content And Artifacts

- [ ] 4.1 Extend Tier A with bounded `table`, `steps`, `flowchart`, `timeline`,
      `callout`, and `draft` response components.

Acceptance: validator and renderer tests reject unknown/oversized data and
render a deterministic artifact without HTML, CSS, JavaScript, or remote URLs.

- [ ] 4.2 Add save, rename, duplicate, and export projections for a gateway-
      owned generated artifact.

Acceptance: a generated artifact survives browser restart and is linked to its
source turn and evidence revision.

## 5. Explicit Page Change

- [ ] 5.1 Add a narrow `editable_text_change` proposal bound to a current
      editable-element anchor, with before value/hash, proposed value, approval,
      apply receipt, and undo receipt.

Acceptance: an approved fixture edit applies once and undo restores the exact
prior value; stale, non-editable, password, or changed-before-apply targets fail
closed.

- [ ] 5.2 Keep declarative visual tweaks on their existing allowlisted path and
      expose both change types in one workspace review history.

Acceptance: the user can distinguish proposed/applied/reverted/rejected state
without reading logs.

## 6. Companion Control

- [ ] 6.1 Project the active companion/profile into the on-page and workspace
      surfaces with visible policy, stop, hide/show, and customization entry.

Acceptance: hiding or changing the companion does not lose workspace state or
change action authority; stop remains reachable from the workspace.

- [ ] 6.2 Bind companion reactions to runtime states using the existing
      declarative `avatar_behavior` contract.

Acceptance: listening/thinking/explaining/waiting/acting/done/error reactions
use known packaged motions only and remain functional with custom appearance.

## 7. Tutorial Workflow

- [ ] 7.1 Define a tutorial as a saved goal, ordered steps, anchor refs,
      completion predicates, correction history, and recap artifact over the
      general situated runtime.

Acceptance: a tutorial can call the same explanation, annotation, artifact,
and approved-action paths; no parallel perception or execution API is added.

## 8. Release Evidence

- [ ] 8.1 Run extension verify/smoke plus the new dynamic-grounding smoke in an
      isolated profile, bump the manifest patch version, and package the unit.
- [ ] 8.2 Reload the user's unpacked extension only when the active-promotion
      gate proves no interruption, and verify the loaded version changed.
- [ ] 8.3 Record any preview/reload blocker with the artifact path.

Acceptance: verification, commit, package, reload status, and post-reload smoke
are recorded as distinct evidence; no step is claimed from an earlier one.

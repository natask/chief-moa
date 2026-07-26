# Tasks

No implementation task is authorized until the architecture and open decisions
are aligned with the user.

## 0. Alignment

- [ ] 0.0 `[in-progress: bounded first slice; no implementation claimed]`
  Draft one same-app-capture decision row naming the owning surface, captured
  fields, excluded fields, and authority required to persist a proposal.
  Acceptance: the reviewed row names one owner, explicit included/excluded
  fields, and confirms that capture grants no implementation authority.
- [ ] 0.1 Align on same-app capture as the first surface.
- [ ] 0.2 Align on self-report-only first scope, screenshot retention, redaction,
  and the architecture/implementation authority selector.
- [ ] 0.3 Define request states, evidence bounds, project-confidence threshold,
  and deletion behavior.

## 1. Self-Report Evidence Proposal

- [ ] 1.1 Add a full-app composer that captures A.G.'s own view, exact package
  and installed release metadata, and typed/spoken user description.
- [ ] 1.2 Add preview/crop/redaction and persist a proposed gateway request.
- [ ] 1.3 Persist bounded `interaction_feedback.v1` with the raw comment,
  typed video evidence refs, time or browser-snapshot anchors, and an exact
  release/candidate/artifact binding.
- [ ] 1.4 Derive a deterministic context proposal with status `unreviewed`.
  Keep it separate from the raw comment and from execution authority.

Acceptance: a self-report record is inspectable with image, version, description,
and provenance. Release feedback rejects a mismatched candidate or artifact
digest. The stored raw comment stays unchanged within its bound, and no run is
launched.

## 2. Project Binding And Work Proposal

- [ ] 2.1 Add versioned package-to-project/release bindings with explicit
  confirmation fallback.
- [ ] 2.2 Add idempotent modification requests with evidence refs and explicit
  authorization class.
- [ ] 2.3 Add an explicit architecture-worker path through worker-pull.

Acceptance: a Chief Moa self-report resolves deterministically to its project;
forged visible text cannot relink it; an explicit architecture request returns a
durable plan artifact without editing code.

## 3. Bounded Implementation And Status

- [ ] 3.1 Add explicit bounded-fix authorization and require before/after/diff/
  verification evidence.
- [ ] 3.2 Show request, run, review, verification, artifact, and deployment state
  in the full app; keep the overlay compact.
- [ ] 3.3 Require a separate explicit user action before unreviewed interaction
  feedback can create or authorize implementation work.

Acceptance: only the explicitly authorized request starts implementation, and
deployment remains subject to the existing promotion gate.

## 4. Other-App Capture

- [ ] 4.1 Add fresh accessibility evidence plus optional explicitly granted
  screenshot capture with visible stale/app-switch failures.
- [ ] 4.2 Add the universal Android Share fallback with `unknown/shared`
  provenance unless independently corroborated.

Acceptance: another app's screenshot is never treated as fresh or authoritative
after the active package changes.

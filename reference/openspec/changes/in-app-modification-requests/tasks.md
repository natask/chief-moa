# Tasks

No implementation task is authorized until the architecture and open decisions
are aligned with the user.

## 0. Alignment

- [ ] 0.1 Align on same-app capture as the first surface.
- [ ] 0.2 Align on self-report-only first scope, screenshot retention, redaction,
  and the architecture/implementation authority selector.
- [ ] 0.3 Define request states, evidence bounds, project-confidence threshold,
  and deletion behavior.

## 1. Self-Report Evidence Proposal

- [ ] 1.1 Add a full-app composer that captures A.G.'s own view, exact package
  and installed release metadata, and typed/spoken user description.
- [ ] 1.2 Add preview/crop/redaction and persist a proposed gateway request.

Acceptance: a self-report record is inspectable with image, version, description,
and provenance, and no run is launched.

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

Acceptance: only the explicitly authorized request starts implementation, and
deployment remains subject to the existing promotion gate.

## 4. Other-App Capture

- [ ] 4.1 Add fresh accessibility evidence plus optional explicitly granted
  screenshot capture with visible stale/app-switch failures.
- [ ] 4.2 Add the universal Android Share fallback with `unknown/shared`
  provenance unless independently corroborated.

Acceptance: another app's screenshot is never treated as fresh or authoritative
after the active package changes.

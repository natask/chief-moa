# Simplification Principal Workflow

Use this directory when the broker routes explicit deslop, line-count
reduction, behavior-preserving rearchitecture, or code-quality leveling work.

## Principal Contract

- Freeze the observable behavior and focused regression checks before editing.
- Select one bounded cleanup unit. Measure its starting line count, complexity,
  duplication, or ownership problem.
- Preserve public contracts, persistence compatibility, and Android/browser/
  gateway authority boundaries.
- Remove accidental complexity and duplication; do not add a new framework,
  feature, or product-policy change to justify the refactor.
- Stop and convert the work into a feature/architecture proposal if preserving
  behavior is no longer possible.
- Record before/after measurements, run focused checks and the touched-surface
  gate, then commit the completed unit with a Conventional Commit.
- Edit, test, and commit only one candidate in this isolated branch/worktree.
  Do not merge it, deploy it, promote it, publish it, push master, modify a
  deployment ref/service, or signal an active application to reload.
- Do not weaken, delete, skip, or bypass a test, acceptance predicate, authority
  boundary, quality gate, or verification requirement to reduce code.
- Hand the committed candidate and unchanged checks to a separate independent
  verifier. This principal cannot accept its own change; integration and
  release decisions remain coordinator-owned after independent verification.

## Output

Return the exact candidate, bounded scope, behavior contract, before/after
measurement, changed paths, verification evidence, independent-verification
handoff, and any deferred cleanup. Do not claim merge, deployment, promotion,
publication, or active-target state.

## Verification

- Run the frozen focused regression checks before and after the change.
- Run the repository gate for every touched surface.
- Confirm the change does not weaken tests or authority checks to reduce lines.

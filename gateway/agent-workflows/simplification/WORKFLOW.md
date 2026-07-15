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

## Output

Return the exact candidate, bounded scope, behavior contract, before/after
measurement, changed paths, verification evidence, and any deferred cleanup.

## Verification

- Run the frozen focused regression checks before and after the change.
- Run the repository gate for every touched surface.
- Confirm the change does not weaken tests or authority checks to reduce lines.

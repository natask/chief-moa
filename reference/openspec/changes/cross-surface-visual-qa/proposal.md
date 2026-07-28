## Why

Android and browser UI can pass behavioral checks while still looking unclear or
inconsistent. The current browser smoke renders the real extension and briefly
writes a screenshot, but removes it at the end; Android has no repeatable visual
capture lane. A review based on ad-hoc screenshots cannot prove which build,
state, viewport, or model produced a decision.

## What Changes

- Define deterministic, real-rendered Android and browser visual states.
- Retain screenshots and machine-readable capture evidence for every state.
- Inventory repository-owned reference images without downloading substitutes.
- Run two bounded capture, critique, refinement, and recapture rounds.
- Use Claude Code with `--model opus` for visual critique and record the model
  identity returned by the tool, while keeping human acceptance authoritative.
- Compare shared companion, transcript ribbon, expanded transcript, focus,
  spacing, and state semantics across surfaces without requiring pixel identity.

## Impact

- Adds a cross-surface visual-QA contract and a dry-run coordinator under
  `scripts/visual-qa`.
- Does not change Android or browser production UI.
- Produces review evidence only; it grants no release or promotion authority.

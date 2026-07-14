## 1. Durable Project Brief

- [x] 1.1 Add bounded project-brief fields to the local project store.
- [x] 1.2 Add an authenticated project update endpoint.
- [x] 1.3 Show and edit the selected project's brief in the gateway console.
- [x] 1.4 Seed project-targeted agent prompts with the saved brief.

## 2. Verification

- [x] 2.1 Smoke project creation, update, persistence, bounds, and auth.
- [x] 2.2 Run gateway checks.

## Verification Evidence

- `cd gateway && npm run smoke:project-state` passed.
- `cd gateway && npm run check` passed: 235 tests passed, 1 skipped.
- `bash scripts/deploy.sh auto` did not publish the gateway because the legacy
  push target is unset; the VPS path requires a verified push through master.
  Unrelated dirty Android and extension files were skipped and left untouched.

# MX preparation merge ledger

| Step | Branch/worktree | Evidence | Result |
|---|---|---|---|
| Create isolated preparation lane | `agent/mx-final-integration-prep` / matching sibling worktree | based on integration `a8595eb` | complete |
| Requirement/compatibility audit | docs-only, no product mutation | committed MX goal, intent map, program ledgers, branch diffs | BLOCK final completion; safe work can continue |
| Fresh gateway gate | integration head, installed dependency tree linked read-only | `npm run check` | 198 pass, 1 skip, 0 fail |
| Fresh extension gate | integration head | `npm run verify && npm run smoke` | pass, real headless extension |
| Fresh Android gate | integration head | `assembleDebug` | build successful |
| Strict specifications | integration head | six named changes | five pass; Aggie change fails before M5 integration |

No product branch was merged. No preview, artifact publication, active browser
reload, OTA, deployment ref, database, queue, worker or live application was
mutated.

## Current-head repair lane (`caba6a1` base)

| Step | Evidence | Result |
|---|---|---|
| Broad source quality gate | gateway 234/0/0; Swift 7/0; Rust 15/0; clippy; context/Aggie quality | manager PASS |
| Disposable Postgres | helper exit 77: no Docker engine or local Postgres tools | explicit SKIP; DB proof remains BLOCK |
| Promotion bypass repair | mandatory exact-commit evidence; no CI ref push; no backup skip; smoke-failure rollback | source/local hostile gate PASS; runtime unproven |

This section records only evidence measured in the repair worktree. It does not
replace the older `a8595eb` audit snapshot and does not claim integration into
the main staging branch.

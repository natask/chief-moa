# Deployment/evidence repair manager audit

Verdict: **manager PASS for source gates; external preview/DB/promotion remains
BLOCKED and unclaimed pending fresh independent audit.**

## Claims ledger

| Implementer claim | Evidence checked | Verdict |
|---|---|---|
| Whole-portfolio local source gate is reproducible and broad | `scripts/final-portfolio-quality-gate.sh`; complete unsuppressed gateway discovery, complete Swift and Rust package tests, focused quality gates | verified locally |
| Gateway broad suite passes | `npm test` measured 234 passed, 0 skipped, 0 failed | verified; not a benchmark or production score |
| Context/Aggie quality thresholds pass | checked-in AST/coverage gates: context max complexity 10, CRAP 11.896296; Aggie named functions max complexity 9, CRAP 9.15 | verified for instrumented functions/corpus only |
| Apple and Windows authority cores pass locally | Swift 7 passed; Rust 15 passed; clippy `-D warnings` passed | verified source/package scope; no device/signing proof |
| Disposable Postgres migration/import/restore/concurrency passes | Docker engine and local Postgres tools absent; helper exited 77 | **unproven / explicit SKIP** |
| CI cannot directly promote | workflow has read-only contents permission and no ref push; updater queries authenticated M4 request detail and matches candidate/review/preview/verification/current fresh apply claim plus verification-bound operational refs | verified by source inspection and 9-case local hostile gate; hosted workflow not run |
| Backup can be skipped | `--skip-backup` exits 64; unconditional backup + scratch restore | refuted bypass / repair verified by syntax and source test |
| Failed post-apply smoke is safe | update checks health, checks out prior full SHA, rebuilds/restarts and health-checks it; no success receipt on failure | verified source path; runtime recovery unmeasured |
| Evidence manifest resists basic forgery | 9 hostile cases cover M4-bound success/receipt, failed verification, wrong commit, aliased resources, same active/preview URL, newline injection, missing claim and receipt mismatch | verified local corpus; authenticated runtime M4 call not exercised |
| Live preview/apply/rollback occurred | no runtime credentials, isolated resources, or authority used | **refuted; no live operation ran** |

Action refs were resolved directly with `git ls-remote` on 2026-07-11 and pinned
to full commit SHAs. This proves immutable workflow source selection, not that a
hosted workflow executed.

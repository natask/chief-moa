# M5 merge ledger

| Time | Unit | State | Evidence |
|---|---|---|---|
| 2026-07-10 | Protocol lane created | active | branch `agent/m5-surface-protocol`, base `2a6a7d5` |
| 2026-07-11 | Repair 1 implemented | audit pending | typed all declared payload families; approval canonical binding; receipt/proposal linkage |
| 2026-07-11 | Focused verification | pass | protocol 12/12; echo smoke PASS; strict OpenSpec PASS; syntax and `git diff --check` PASS |
| 2026-07-11 | Full gateway verification | pass | `npm run check`: 193 pass, 1 skip, 0 fail |
| 2026-07-11 | Fresh audit cycle 2 | block | approval validation, event-only replay, echo retention, additive security, measured complexity |
| 2026-07-11 | Repair 2 implemented | verification active | direct hostile tests plus AST/V8 quality gate; no native/signing/device claim |
| 2026-07-11 | Repair 2 verification | pass | focused 13/13; echo smoke; quality max cyclomatic 9 / CRAP 9.47; strict OpenSpec; full gateway 194 pass, 1 skip |
| 2026-07-11 | Fresh audit cycle 3 | block | normalized credential families, complete surface identity, CRAP contract mismatch |
| 2026-07-11 | Repair 3 implemented | verification active | hostile corpus/full-surface tests; CRAP threshold corrected to 15 |
| 2026-07-11 | Repair 3 verification | pass | focused 13/13; quality/echo/OpenSpec PASS; voice-audio-storage passed twice; full gateway 194 pass, 1 skip |

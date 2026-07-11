# Claims ledger

Use one row per claim. Implementer notes are hostile evidence until independently
verified.

| ID | Requirement | Claimant/lane/commit | Claim | Type | Threshold | Evidence/command/environment/sample/time | Auditor/action | Status | Trust impact | Anti-gaming check | Unknowns/repair/re-audit | Artifact/rollback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PLAN-001 | Existing versioned voice/profile/sampler seam | research lane; read-only | Architecture and deterministic smokes exist | architecture/inference | n/a | source paths and smoke inventory; 2026-07-10 | goal auditor inspected repo | verified for existence, unproven live | session-only override must not persist | no live score inferred | browser parity and live behavior unknown | n/a |
| PLAN-002 | Cascaded TTS reliability | research lane; read-only | ordered chunks, fallback, and metrics exist | architecture/inference | n/a | gateway voice modules and deterministic smokes | anti-gaming audit | verified for code shape, unproven production reliability | logs/retention require review | text generation is not audio heard | no live provider or phone run | n/a |
| PLAN-003 | Portfolio-wide implementation readiness | parent program | all requested programs can safely implement together | architecture | green | adversarial scope audit | security/anti-gaming auditor | refuted | authority and promotion boundaries conflict | rejected scope bundling | repository inventory and architecture decisions missing | n/a |

## Measured results

No paid benchmark, external model evaluation, live provider latency run, or
real-phone playback benchmark was run in this planning unit. All such results
are **NOT MEASURED**.

Future measured rows must include metric, environment, provider/mode, fixture and
sample count, command, timestamp, commit/artifact digest, raw evidence path,
distribution/result, threshold, and verdict.

## Architecture-confidence targets (not benchmark scores)

| Area | Target | Current architecture-confidence | Evidence | Residual unknowns |
|---|---:|---:|---|---|
| Voice profile reversibility | 95+ | 82 | versioned store, sanitizer, revert/reset smokes | live cross-device and failure recovery not measured |
| Voice sampling safety | 95+ | 80 | session-only override and Android consumer | browser parity and live provider behavior unmeasured |
| TTS reliability/diagnosis | 95+ | 68 | chunking, fallback, timing/error fields | phase API, injected failure matrix, phone playback missing |
| Browser tweak trust boundary | 95+ | 84 | typed allowlist, local compilation, receipts | generalized UI tiers and stale/replay attacks incomplete |
| Autonomous deployment safety | 95+ | 62 | guarded scripts, workflow, rollback concepts | isolated preview and real backup/restore evidence incomplete |
| Native desktop/iOS/Windows | 85+ | 20 | architecture intent only | applications, permissions, signing, updates absent |

These are planning judgments about controls and proof coverage, not measured
benchmark results. They must be revised by independent auditors as evidence
lands.

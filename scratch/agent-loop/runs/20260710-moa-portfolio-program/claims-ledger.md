# Claims ledger

Use one row per claim. Implementer notes are hostile evidence until independently
verified.

| ID | Requirement | Claimant/lane/commit | Claim | Type | Threshold | Evidence/command/environment/sample/time | Auditor/action | Status | Trust impact | Anti-gaming check | Unknowns/repair/re-audit | Artifact/rollback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PLAN-001 | Existing versioned voice/profile/sampler seam | research lane; read-only | Architecture and deterministic smokes exist | architecture/inference | n/a | source paths and smoke inventory; 2026-07-10 | goal auditor inspected repo | verified for existence, unproven live | session-only override must not persist | no live score inferred | browser parity and live behavior unknown | n/a |
| PLAN-002 | Cascaded TTS reliability | research lane; read-only | ordered chunks, fallback, and metrics exist | architecture/inference | n/a | gateway voice modules and deterministic smokes | anti-gaming audit | verified for code shape, unproven production reliability | logs/retention require review | text generation is not audio heard | no live provider or phone run | n/a |
| PLAN-003 | Portfolio-wide implementation readiness | parent program | all requested programs can safely implement together | architecture | green | adversarial scope audit | security/anti-gaming auditor | refuted | authority and promotion boundaries conflict | rejected scope bundling | repository inventory and architecture decisions missing | n/a |
| W1-VOICE-DIAG | P1 local voice diagnosis | voice observability lane; integrated commits through `b840249` | authenticated bounded diagnosis attributes eight phases and includes metadata-only failures | deterministic architecture | focused + full gateway gate | diagnosis unit/smoke; `npm run check`; 2026-07-10; 155 pass/1 skip/0 fail | correctness/security/anti-gaming ring plus repair cycles | verified deterministically | summaries allowlisted/redacted; no provider console dependency | failure fixtures and conservative unknown case checked | live provider and phone playback remain unmeasured | integration ref; no active deployment |
| W1-SAMPLER | Browser session-only voice sampling | browser sampler lane; integrated commits through `7a6d573` | bounded sequential samples do not mutate profile and cancel safely | deterministic architecture | 7 lifecycle tests + real extension smoke | verify, sampler smoke, headless extension smoke; 2026-07-10 | lifecycle/security auditor after two repairs | verified deterministically | no mic capture; session-only override | cancel/setup/socket/revocation faults exercised | real provider audio/device output unmeasured | `A.G.-0.1.28.zip`; previous package is rollback |
| W1-CONTRACT | P1 voice product contracts | voice contract lane; integrated commits through `6d2e9ad` | normative specs distinguish target state and exact gates | architecture | strict validation | both strict OpenSpec validations; 2026-07-10 | spec/anti-gaming auditor after repairs | verified | trust/auth/retention requirements explicit | placeholder and false-current-state claims removed | target turn-pinning implementation still incomplete by design | non-deployable docs |
| P2-UI-SPEC | Bounded engine-served browser UI | P2 lane; integrated through `538d0fb` | actual isolated gateway validation/storage feeds a loaded extension, storage refresh changes DOM without source change, refreshes coalesce, actions and traversal are bounded | deterministic runtime | focused gates + repeated real Chrome | actual gateway + unpacked Chrome smoke 5/5 lane and 3/3 integrated; extension verify; gateway full check 155 pass/1 skip/0 fail; 2026-07-10 | three hostile BLOCK/repair cycles; final manager rerun | verified for single-token isolated runtime | server data remains proposal; action allowlist; pre-traversal caps; no executable payload | fake gateway removed; source SHA and GET count observed; nested Proxy read counts | hosted multi-user identity, production volume/performance, active reload remain unmeasured | `A.G.-0.1.29.zip`; prior 0.1.28 package is rollback |
| MF-IDENTITY | Trusted tenant relational writes/event namespaces | MF lane; integrated through `95e1b81` | all seven writers reject body tenant override; event authority uses trusted tenant; versioned domain-separated event identifiers resist delimiter, truncation, and representation-alias attacks | deterministic architecture | focused hostile + full gateway | focused 8/8; combined gateway 172 pass/1 skip/0 fail; 2026-07-10 | multiple BLOCK/repair cycles; final fresh hostile PASS | source write boundary only; hosted auth/RLS/reads remain staged | auditor reproduced and repair closed long-prefix and digest-shaped alias attacks | disposable Postgres, migration/restore, hosted request identity, retention/delete remain unmeasured | source commits; no deploy/DB apply |
| MT-TELEMETRY | Privacy/resource-bounded semantic telemetry foundation | MT lane; integrated through `c55d83d` | closed vocabularies, numeric release + prefixed UUID correlation, bounded queue/batch, abort-aware single-flight quarantine | deterministic architecture | focused hostile + full gateway + strict spec | focused 9/9; combined gateway 172 pass/1 skip/0 fail; strict OpenSpec valid; 2026-07-10 | independent BLOCK on identity leakage/unresolved work; repair; semver metadata BLOCK; repair; final fresh PASS | telemetry is derived/loss-tolerant, not product authority | hostile identity strings, cooperative abort, and non-cooperative permanent hang exercised | no client adapters, consent/deletion, Collector/backend preview, production resource/SLO/vendor evidence | library/spec only; no deployable artifact |

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

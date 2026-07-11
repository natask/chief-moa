# MX requirement-to-evidence ledger

Date: 2026-07-11. Audited integration head: `a8595eb`. Manager reports are
treated as claims; the fresh commands below are the measured evidence from this
lane. `PASS` means only the named scope passed, never production readiness.

## Intent coverage

| Intent/program | Authoritative requirement | Current evidence | Verdict | Missing proof / next gate |
|---|---|---|---|---|
| P1 reliable voice | Bounded diagnosis, visible fallback, no lost transcript, safe voice controls | Integrated P1 commits; fresh gateway check includes voice diagnosis/storage/session smokes; voice OpenSpecs strict-valid | PASS for deterministic local behavior | Live STT/TTS/model sockets, real phone playback, production latency/reliability and drain are unmeasured |
| P1 sampling/profile | Session-only sampling, reversible profile changes, no profile mutation by samples | Integrated extension sampler; fresh extension verify includes 7 lifecycle tests and real headless smoke | PASS for local extension lifecycle | Paid/live audio quality, Android real-device sampling and cross-device failure recovery unmeasured |
| P2 browser customization | Typed/bounded proposal, local validation, preview/revert/receipt, unchanged package | Integrated through `538d0fb`; prior repeated actual gateway/Chrome proof; fresh extension verify/smoke passes | PASS for bounded local artifact/runtime seam | Active reload, hosted multi-tenant identity and production volume/resource behavior unmeasured |
| MF identity/data | Trusted tenant writers and unambiguous event identity | Integrated through `95e1b81`; fresh gateway unit/smoke gate passes tenant hostile cases | PASS for source/unit seam | Disposable Postgres migration/import/restore, hosted auth principal and retention/delete proof absent |
| MT telemetry | Moa-owned bounded, redacted, loss-tolerant semantic export seam | Integrated through `c55d83d`; fresh gateway telemetry tests and strict OpenSpec pass | PASS for gateway foundation | Android/browser adapters, consent/deletion E2E, Collector/backend preview, SLO/alerts/vendor trial absent |
| M3 context/retrieval | Bounded canonical context, privacy/deletion/incognito/branch authority, interruption/fork continuity, cache identity | Candidate branch `065d7d5` is not integrated; nine commits and repair ledgers exist | BLOCK integration pending fresh independent green verdict and Tier-0 focused rerun | Rerun context tests, quality check, interruption/fork/invalidation smokes, strict specs, merge audit and combined gateway gate against staging |
| M4 deployment control | Typed proposal through guarded apply/receipt/rollback; no shell or implicit promotion | Integrated `b533d71` + `397020d`; fresh gateway focused deployment tests pass | PASS for deterministic JSONL/Postgres projection source seam | No live adapter, isolated target, preview URL, drain/resume, backup/restore, apply, rollback or post-smoke evidence |
| MB billing | Immutable metering/prices/budgets/entitlements; verified webhook evidence; sandbox cannot charge | Integrated `2a6a7d5`; fresh 9 billing tests pass | PASS for provider-neutral in-process sandbox | Migration/app-role restore, cross-process atomic reservation, provider/tax/refund/grace/business authority absent; real payment authority BLOCKED |
| M5 proposal/approval/receipt | Stable Aggie protocol with full surface authority, stale/replay defenses and N/N-1 compatibility | Candidate branch `5869ff9` is not integrated; three commits and hostile audit exist | BLOCK integration pending fresh independent green verdict, strict OpenSpec repair, and Tier-0 rerun | `openspec validate define-aggie-compatible-surface --strict` currently fails: no parsed delta in integration head; candidate must prove strict spec plus facade/event/echo/N/N-1 gates |
| M5 native surfaces | macOS -> iOS -> Windows, native permissions/secure tokens/actions/signing/updates/receipts | No native product branches or platform artifacts in the committed portfolio evidence | NOT IMPLEMENTED | Protocol freeze first; then platform builds, UI/accessibility/security, signed isolated updates, physical-device smokes and rollback per OS |
| M6 companions | Signed bounded non-executable packages, provenance/license/moderation/compatibility/revocation and reversible apply | Integrated `a8595eb`; fresh 11 package tests and strict companion OpenSpec pass | PASS for local package verifier/planning seam | Hosted publish/install, tenant privacy, public trust root, license/moderation/appeals authority, offline revocation freshness, client apply/rollback absent |
| MX whole system | Serial dependency-safe integration, combined gates, artifacts/previews, adversarial recovery and safe promotion | This preparation ledger; no final whole-goal integration has occurred | IN PROGRESS | Integrate green M3 then M5 protocol; native sequence; fresh auditor ring; migrations/restores; isolated previews; promotion gate |

## Fresh measured evidence

| Command/environment | Result | Scope limits |
|---|---|---|
| `cd gateway && npm run check` at `a8595eb`, Node 26, existing installed dependency tree | 198 passed, 1 intentional slow skip, 0 failed | Postgres tests skipped because no `DATABASE_URL`; no paid/live provider calls |
| `cd browser_extension && npm run verify && npm run smoke` | PASS; 7 sampler tests and real unpacked headless Chrome smoke | No active-browser reload or hosted gateway |
| `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug` | BUILD SUCCESSFUL; 33 tasks | Debug build, not real-device/OTA/accessibility/signing proof |
| Strict OpenSpec: voice runtime, streaming voice, telemetry, companion, context | PASS | Spec parsing, not runtime behavior |
| Strict OpenSpec: `define-aggie-compatible-surface` | FAIL: no delta parsed on current integration head | Expected before M5 integration, but M5 cannot be green until candidate validation passes |

The first gateway attempt in the clean MX worktree failed because worktree-local
dependencies were absent. After linking the already-installed main-worktree
`gateway/node_modules` (an ignored local setup artifact), the authoritative
rerun passed. The failed setup attempt is not counted as a product regression.

No paid benchmark, external model evaluation, live-provider latency test,
production traffic trial, payment-provider operation, physical-device matrix,
or observability-vendor preview ran. Therefore there are no measured benchmark
scores in this ledger.

## Compatibility and authority matrix

| Producer | Consumer / shared authority | Compatibility risk | Required integration proof |
|---|---|---|---|
| MF tenant/event identity | M3 cache/source identity, MB ledger, M4 event projection, M6 hosted sharing | A local constructor may appear tenant-safe while HTTP/read paths or derived IDs are not | Two-principal route tests; event replay/rebuild; no body-supplied tenant; cache keys include tenant/version |
| MT semantic envelope | Every later manager | Domain events must not become telemetry authority or leak IDs/content/financial facts | Closed vocabulary and redaction tests for each new event; exporter-down remains product-neutral |
| M3 context artifact | Voice, broker and future Aggie clients | Existing context-decision/history paths can duplicate ranking, bypass preflight, or disagree on deletion/branch semantics | Merge audit of all context entry points; canonical receipt/source IDs; incognito/delete/fork/interruption probes |
| M4 deployment events | Existing work-history HTTP/intent routes and deploy scripts | A direct route or old deploy path could bypass request/review/claim/receipt policy | Route-to-state-machine E2E; enumerate every deploy command/path; fake adapter must not be called live proof |
| MB billing schema | MF migration/RLS substrate and future entitlements | Process-local domain may diverge from DB isolation/atomicity | Disposable Postgres up/down/restore and concurrent two-principal reservation tests |
| M5 Aggie protocol | Android/browser/native/M6 apply | Surface ID alone is insufficient authority; additive credentials and protocol forks can bypass local approval | Full surface kind/mode/device binding, unknown-field fail-closed tests, N/N-1 matrix, existing-client regressions |
| M6 verified package | Existing mutable companion catalog/profile routes | New signed package planning seam does not automatically secure legacy catalog create/apply endpoints | Route inventory and explicit trust-policy handoff; prove unverified packages cannot reach profile mutation |

## Dependency graph and serial integration order

```text
P1/P2 + MF + MT + M4 + MB + M6-package  [already on staging]
                 |
                 +--> M3 fresh PASS --> integrate M3 --> combined gateway/spec audit
                 |
                 +--> M5 protocol fresh PASS + strict spec --> integrate protocol
                                                        |
                                      macOS --> iOS --> Windows
                                                        |
                              hosted M6 sharing/apply integration
                                                        |
                   whole-goal auditor ring --> repairs --> previews/artifacts
                                                        |
                     complete promotion gate --> guarded active apply + receipt
```

M3 may integrate as soon as its fresh audit and Tier-0 reruns are green. M5
protocol may be prepared in parallel but must not be called frozen until its
strict spec and hostile audit are green. Native implementation remains serial
after protocol freeze. M6's local package seam is integrated, but hosted
sharing/apply remains after protocol and identity authority are proven.

## Architecture confidence (not measured scores)

| Area | Qualitative confidence | Evidence | Residual unknowns |
|---|---|---|---|
| P1/P2 local deterministic seams | high | repeated focused tests, real headless extension smoke, strict specs | live providers/devices/hosted identity |
| MF/MT foundations | medium-high | hostile repairs, full local gateway gate | real Postgres, clients, Collector, consent operations |
| M4 state-machine source | medium-high | recovery/idempotency hostile tests | real adapters and every promotion prerequisite |
| MB sandbox | medium | money/idempotency/security properties | database concurrency and all commercial/provider policy |
| M6 local package seam | medium-high | structural media and supply-chain hostile tests | public trust/moderation and client lifecycle |
| M3 candidate | unassigned pending fresh audit | candidate code/repair history exists | current independent verdict and integration behavior |
| M5 protocol candidate | unassigned pending fresh audit | candidate code/repair history exists | strict spec failure, current verdict and client compatibility |
| Native/product completion | low | architecture and sequencing only | all three implementations, signing, devices, accessibility, updates |

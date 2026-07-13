# MX whole-goal preflight audit

Verdict: **BLOCK final completion; repair/integration required.** This is not a
block on continuing safe work.

## Claims ledger

| Implementer claim | Evidence checked | Auditor verdict |
|---|---|---|
| Current staging is locally coherent | Fresh gateway, extension, Android and strict-spec commands at `a8595eb` | Verified for local P1/P2/MF/MT/M4/MB/M6-package scope; PASS with stated skips |
| M3 is ready to integrate | Candidate branch history/diff only; no fresh MX rerun or final independent verdict in staging | UNPROVEN; fresh audit and Tier-0 gates required |
| M5 protocol is ready to freeze | Candidate branch history/diff; current strict OpenSpec fails because staging has no delta | UNPROVEN; candidate strict validation and fresh audit required |
| Native surfaces satisfy the user's intent | Goal/map and repo evidence show no macOS/iOS/Windows product units | REFUTED; implementation/evidence absent |
| M6 completes public sharing | Package verifier tests pass, but public trust/moderation/hosted routes/client apply are explicitly unwired | REFUTED; local package seam only |
| M4 proves safe deployment | Deterministic state machine passes; no real preview/apply/rollback evidence | REFUTED as deployment claim; PASS only as source seam |
| MB proves payments | Sandbox cannot charge and live policy/provider is absent | REFUTED as payments claim; PASS only as no-charge domain seam |
| Portfolio is promotable | No separate URL/state/queue/storage/worker preview or full operational evidence | BLOCK promotion |

## Cross-section findings

1. **Legacy/new authority duplication:** M6 adds a verified package seam while
   existing companion catalog/profile routes remain mutable. Integration must
   prove which route is authoritative and that unsigned/untrusted content
   cannot reach profile mutation.
2. **Context duplication risk:** M3 changes hundreds of lines in `server.js`
   alongside existing context decision, history, broker packs and voice context.
   A merge auditor must enumerate every context ingress and prove one privacy
   decision precedes retrieval everywhere.
3. **Deployment bypass risk:** M4 state is guarded, but existing deployment
   scripts, work-history routes and auto-promotion policy are adjacent systems.
   Final audit must prove no direct route or script treats a model proposal as
   applied authority.
4. **Schema proof gap:** MF and MB claim migration/RLS shape while the fresh
   Postgres integration tests are skipped. Source inspection cannot substitute
   for migration, role isolation and scratch-restore evidence.
5. **Protocol/spec mismatch:** current `define-aggie-compatible-surface` strict
   validation fails. The M5 candidate may contain its delta, but the candidate
   must be validated before integration and the staging result rerun afterward.
6. **Native omission:** macOS, iOS and Windows are required serial programs, not
   optional confidence targets. Their absence prevents portfolio completion.
7. **Gate staleness:** prior artifact hashes predate MB/M4/M6 and cannot prove
   the current integrated source. Fresh deployable artifacts are required after
   final integration; creation alone is not preview or applied-runtime proof.

## Anti-gaming checks

- Exact local pass counts are not called benchmarks or production reliability.
- The gateway's skipped Postgres/slow suites are explicit.
- A headless Chrome smoke is not active-browser or hosted-user proof.
- An Android debug APK is not physical-device, OTA, release-signing or
  accessibility proof.
- Fake deployment adapters and planning receipts are not live effects.
- Signed package validation is not marketplace authority.
- Model/auditor reputation is not evidence.

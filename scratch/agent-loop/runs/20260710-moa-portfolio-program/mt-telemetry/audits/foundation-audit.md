# MT telemetry foundation adversarial audit

Date: 2026-07-10

## Verdict

**REPAIR REQUIRED / fresh verdict pending for the isolated unit. BLOCK for the
complete MT manager outcome.** An independent Tier 0 audit refuted the original
PASS because release/correlation fields admitted identity-shaped values and a
timed-out non-cooperative adapter could accumulate unresolved work. The current
repair adds strict formats and a single-flight quarantine, but must be freshly
audited. It is not wired into runtime surfaces or a backend.

## Specialized findings

- Correctness: PASS for envelope construction, opaque ID validation, and bounded
  queue/single-flight semantics.
- Security/privacy: PASS for the explicit default-deny unit boundary. Residual
  unknown: no legal policy or representative scrubbed adversarial corpus.
- Performance/resource: PASS architecture bounds; no measured CPU, RSS, network
  or production latency claim is permitted.
- Quality/CRAP/complexity: PASS by inspection for narrow functions and direct
  branch tests; no measured CRAP tool output was produced.
- Anti-gaming: PASS for unit claims because tests invoke runtime code and the
  ledger explicitly refuses to treat them as Collector/client/production proof.
- Integration: BLOCK. No Android/extension adapter, consent/deletion authority,
  Collector/backend preview, cross-surface query, SLO, alert, or production SDK
  exists in this commit.

## Repair/dependency contract

After MF identity/data integrates, define scoped analytics consent and deletion,
then implement client release/crash adapters in disjoint lanes. Run an isolated
Collector/backend preview with a separate URL/state and measure mapping,
sensitive-data exclusion, serialized bytes/event, queue high-water/drop count,
export latency/failure, CPU/RSS delta, retention and price inputs. Only then may
the manager select a vendor or claim cross-surface ingestion.

The attempted fresh CLI auditor used GPT-5.4 high reasoning but its final verdict
was not recoverable from the CLI output. Its partial read is not counted as an
auditor pass; the evidence above is the manager's adversarial review and must be
rechecked by Tier 0 or a fresh independent auditor before integration.

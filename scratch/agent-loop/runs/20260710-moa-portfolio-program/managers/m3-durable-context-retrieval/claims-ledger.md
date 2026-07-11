# Claims ledger

| Implementer claim | Status | Evidence | Verdict |
|---|---|---|---|
| Canonical context artifact carries version, artifact id, cache identity, source ids, ranking rationale, and redaction metadata | verified | `gateway/lib/context-artifact.js`; `node --test test/context-artifact.test.js`; `node scripts/smoke-context-artifact.js` | pass for M3-1 |
| Chat and cascaded voice both consume the shared artifact seam | verified by source audit, unproven by runtime smoke in this environment | `gateway/server.js` wiring at chat + HTTP voice + cascaded voice call sites; `node --check server.js` | source-wired pass |
| Incognito/deleted/secret-like content cannot leak into artifact text or receipt | verified for the bounded source unit | focused unit + smoke cover deleted/incognito omission and secret-like redaction | pass for M3-1 |
| Cache identity changes on query/source revision change and stays stable for equivalent inputs | verified | focused unit test assertions on `cache_identity.key` | pass for M3-1 |
| Full gateway regression is green under Tier-0 verification | verified | dependency-complete worktree; `cd gateway && npm run check` -> 176 pass / 1 skip / 0 fail | pass |

Measured results and architecture-confidence are recorded after verification and
audit.

## Measured results

- Focused unit gate: `cd gateway && node --test test/context-artifact.test.js`
  -> 4 passed, 0 failed.
- Focused smoke gate: `cd gateway && node scripts/smoke-context-artifact.js`
  -> pass.
- Focused syntax gate: `cd gateway && node --check server.js && node --check
  lib/context-artifact.js` -> pass.
- Tier-0 full gateway gate with the repository's installed dependency tree:
  `cd gateway && npm run check` -> 176 passed, 1 skipped, 0 failed.
- Compatibility repair: the first full run found the established durable
  context header missing; restoring it made `smoke-session-history` and the full
  suite pass without weakening the artifact assertions.

## Architecture-confidence only

M3-1 materially improves inspectability and cache invalidation for bounded
retrieval without broadening scope into provider memory or a vector store.
Confidence is higher for prompt provenance, duplicate resistance, and
secret-like-text masking on the changed source unit. Hosted multi-tenant read
authority, deletion lifecycle jobs, and end-to-end chat/voice runtime proof in
this sandbox remain unproven and explicitly blocked on MF authority and missing
local dependencies.

## Audit cycles

- Cycle 1: PASS for privacy and anti-gaming on the pure artifact module.
- Cycle 2: BLOCK on performance hygiene because the server still computed legacy
  context builders even when the artifact succeeded.
- Repair M3-1-R1: gate the legacy builders behind artifact absence so the new
  path does not duplicate retrieval work.
- Cycle 3: PASS for the bounded source unit after rerunning focused unit, smoke,
  and syntax gates.

## Commit / deploy status

- The nested executor could not write Git metadata; Tier 0 owns the conventional
  commit after these gates.
- No preview or live deploy was attempted.

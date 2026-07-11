# Claims ledger

| Implementer claim | Status | Evidence | Verdict |
|---|---|---|---|
| Canonical context artifact carries version, artifact id, cache identity, and receipt metadata only for actually rendered sources | verified | `gateway/lib/context-artifact.js`; focused non-rendered-source repro | pass after M3 repair |
| Chat and cascaded voice both consume the shared artifact seam | verified by source audit, unproven by runtime smoke in this environment | `gateway/server.js` wiring at chat + HTTP voice + cascaded voice call sites; `node --check server.js` | source-wired pass |
| Incognito/deleted/OAuth/PAT-like content cannot leak into artifact text or receipt | verified for named deterministic corpus | focused tests cover deleted/incognito, OAuth query and encoded query credentials, bearer/API and common PAT formats | pass for tested corpus; not a universal secret detector |
| Cache identity changes on query/source revision change and stays stable for equivalent inputs | verified | focused unit test assertions on `cache_identity.key` | pass for M3-1 |
| Run/task operational context is session/branch scoped | verified for file-store collection seam | forged cross-session reference and cross-branch run/task fixtures | pass; hosted tenant authorization remains unproven |
| Candidate work is bounded before full untrusted sort/copy/redaction | verified deterministically | 10,000-source hostile fixture observes fewer than 100 rank getter reads; hard 256 / 4x candidate, 8-line and 4,000-char bounds | pass; production latency unmeasured |
| Full gateway regression is green under repair verification | verified | dependency-complete worktree; `cd gateway && npm run check` -> 182 pass / 1 skip / 0 fail | pass |

Measured results and architecture-confidence are recorded after verification and
audit.

## Measured results

- Focused unit + collection gate: `cd gateway && node --test
  test/context-artifact.test.js test/context-artifact-scope.test.js` -> 10 passed,
  0 failed.
- Focused smoke gate: `cd gateway && node scripts/smoke-context-artifact.js`
  -> pass.
- Focused syntax gate: `cd gateway && node --check server.js && node --check
  lib/context-artifact.js` -> pass.
- Tier-0 full gateway gate with the repository's installed dependency tree:
  `cd gateway && npm run check` -> 182 passed, 1 skipped, 0 failed.
- Compatibility repair: the first full run found the established durable
  context header missing; restoring it made `smoke-session-history` and the full
  suite pass without weakening the artifact assertions.

## Architecture-confidence only

M3-1 materially improves inspectability and cache invalidation for bounded
retrieval without broadening scope into provider memory or a vector store.
Confidence is higher for prompt provenance, duplicate resistance, named
secret-format masking, and file-store session/branch collection on the changed
source unit. Hosted multi-tenant read
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
- Cycle 4: BLOCK on OAuth/PAT redaction breadth, rendered-source receipt truth,
  run-reference scope bypass, and pre-sort/pre-redaction resource bounds.
- Repair M3-1-R2: added named hostile secret formats, rendered-only provenance,
  stored session/branch filtering, fixed candidate/line bounds, and linear text
  length accounting.
- Cycle 5: fresh independent audit pending; no PASS claim until recorded.

## Commit / deploy status

- M3-1 base is commit `c9376ee`; the repair is committed separately after gates.
- No preview or live deploy was attempted.

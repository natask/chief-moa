# Claims ledger

| Implementer claim | Status | Evidence | Verdict |
|---|---|---|---|
| Canonical context artifact carries version, artifact id, cache identity, and receipt metadata only for actually rendered sources | verified | `gateway/lib/context-artifact.js`; focused non-rendered-source repro | pass after M3 repair |
| Chat and cascaded voice both consume the shared artifact seam | verified by source audit, unproven by runtime smoke in this environment | `gateway/server.js` wiring at chat + HTTP voice + cascaded voice call sites; `node --check server.js` | source-wired pass |
| Incognito/deleted/OAuth/PAT-like content cannot leak into artifact text or receipt | verified for named deterministic corpus | focused tests cover deleted/incognito, OAuth query and encoded query credentials, bearer/API and common PAT formats | pass for tested corpus; not a universal secret detector |
| Cache identity changes on query/source revision change and stays stable for equivalent inputs | verified | focused unit test assertions on `cache_identity.key` | pass for M3-1 |
| Run/task operational context is session/branch scoped | verified for file-store collection seam | forged cross-session reference and cross-branch run/task fixtures | pass; hosted tenant authorization remains unproven |
| Candidate work is bounded before full untrusted sort/copy/redaction | verified deterministically | 10,000-source hostile fixture observes fewer than 100 rank getter reads; hard 256 / 4x candidate, 8-line and 4,000-char bounds | pass; production latency unmeasured |
| Encoded and metadata secrets stay behind the redaction boundary | verified for named hostile corpus | triple/malformed percent encoding; secret-shaped query, scope, IDs, labels, timestamp and revision fixture | pass for tested corpus; maximum three canonical decode rounds |
| Operational context preserves provenance and excludes private lifecycle states | verified for file-store seam | stored branch assertions; deleted/incognito flag and incognito-branch fixtures under all-branches collection; fork parent-reference fixture | pass; hosted tenant authorization still unproven |
| Complexity <=10 and CRAP <=15 | measured reproducibly | locked-dependency `npm run check:context-quality` reports max complexity 10 and max CRAP 11.896296 (`normalizeSource`) | pass for `context-artifact.js` focused corpus |
| Full gateway regression is green under repair verification | verified | dependency-complete worktree; `cd gateway && npm run check` -> 189 pass / 1 skip / 0 fail | pass |

Measured results and architecture-confidence are recorded after verification and
audit.

## Measured results

- Focused unit + collection gate: `cd gateway && node --test
  test/context-artifact.test.js test/context-artifact-scope.test.js` -> 17 passed,
  0 failed.
- Focused smoke gate: `cd gateway && node scripts/smoke-context-artifact.js`
  -> pass.
- Focused syntax gate: `cd gateway && node --check server.js && node --check
  lib/context-artifact.js` -> pass.
- Tier-0 full gateway gate with the repository's installed dependency tree:
  `cd gateway && npm run check` -> 189 passed, 1 skipped, 0 failed.
- Locked quality gate: `npm run check:context-quality` -> maximum complexity 10;
  maximum function CRAP 11.896296 (`normalizeSource`), below 15.
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
- Repair M3-1-R3: retained only explicitly referenced parent-branch runs for
  fork continuity and covered single/double percent-encoded OAuth credentials.
- Cycle 5: three fresh independent CLI audit paths were attempted after the
  repair, but none produced a verdict: Codex GPT-5.4/high completed read phases
  without a final message (including explicit last-message capture), Gemini
  exited 41 for missing configured Vertex/API-key authority, and Claude
  Opus/high exited without output. Independent PASS remains unproven; the
  manager's direct specialized audit is recorded separately and is not
  substituted for independence.
- Cycle 6: collaboration audit BLOCK on triple/malformed canonicalization,
  metadata leakage, operational incognito/deleted provenance, all-branches
  fixtures, and missing measured complexity/CRAP evidence.
- Repair M3-1-R4: canonical decode/redaction and metadata policy, stored
  lifecycle/provenance filtering, hostile all-branches fixtures, and quality
  refactor/gates. Fresh collaboration re-audit required before integration.
- Cycle 7: collaboration audit BLOCK on an out-of-scope standing-fact `run`
  reference, requested rather than stored run provenance, OAuth state leakage,
  missing assembly-level provenance cases, and non-reproducible quality tooling.
- Repair M3-1-R5: global standing provenance, stored run branch, canonical OAuth
  state redaction, assembly-level standing/all-branches/fork tests, and durable
  lockfile-compatible `check:context-quality` command/report.
- Cycle 8: fresh GPT-5.4/xhigh hostile audit refuted correct new/incognito
  retrieval scoping. Chat and cascaded voice assemble caller-branch recency
  before the model's final context decision; HTTP voice resolves its filing
  decision first but still assembles from the caller branch. This conflicts with
  the OpenSpec requirement that a new or incognito thread load standing facts
  without old-thread recency. Verdict: BLOCK; revised architecture contract
  required before repair.
- Repair M3-1-R6: dedicated context-free, forced single-tool decision preflight
  precedes one resolved-scope artifact and a fresh answer request. Explicit
  client actions and local utilities skip preflight; answer tools exclude
  `context_management`; new/incognito artifacts and their fail-soft legacy path
  are standing-only; fork lineage and the cascaded recorder reuse the same
  filing result.
- R6 measured deterministic evidence: decision/artifact smokes pass; focused
  preflight tests 3/3; both strict OpenSpec changes valid; full gateway 192
  passed, 1 skipped, 0 failed; context-artifact quality maximum complexity 10
  and maximum CRAP 11.896296. No live/paid provider call, latency benchmark,
  external evaluation, preview, or deployment was run. Fresh independent audit
  remains required.
- Cycle 9: R6 fresh audit BLOCKED cascaded pre-classification privacy, durable
  branch mutation before answer success, completed-turn replay, answer-tool
  branch attribution, and missing hostile lifecycle coverage.
- Repair M3-1-R7: cascaded turns now resolve explicit/warranted privacy before
  classification; chat and cascaded filing use one frozen plan whose branch and
  fork cutoff feed retrieval and are committed only after answer success;
  answer tools use that planned branch; completed chat and cascaded turn ids
  replay before preflight; an incognito non-chat classification is prevented
  from launching actions or creating durable state. Deterministic failure fixtures cover absent,
  malformed, unknown, duplicate, and thrown preflight results, and retry
  fixtures prove no repeat provider requests or new branch ids.
- R7 deterministic evidence now has an explicit twelve-row claims map in
  `hostile-matrix-r7.md`. It includes captured OpenAI/Vertex preflight shapes,
  new/fork/incognito payload sentinels, cascaded stream ordering, HTTP scope,
  failure/mutation cases, completed replay, direct answer-transport failure with
  before/after thread-store inspection, and forced artifact failure for new and
  incognito. Focused context-decision tests are 5/5 and the decision, artifact,
  cascaded-reasoner, and incognito smokes pass. Final full-gateway and strict
  spec results: full gateway 194 passed, 1 skipped, 0 failed; both strict
  OpenSpec validations pass; context-artifact quality maximum complexity 10 and
  maximum CRAP 11.896296. No paid/live provider call, benchmark, preview, or
  deployment was run.

## Commit / deploy status

- M3-1 base is commit `c9376ee`; the repair is committed separately after gates.
- No preview or live deploy was attempted.

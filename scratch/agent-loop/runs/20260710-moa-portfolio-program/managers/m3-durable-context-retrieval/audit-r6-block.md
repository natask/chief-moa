# M3 fresh hostile audit R6 — BLOCK

Auditor execution: fresh read-only Codex GPT-5.4/xhigh session
`019f5004-0693-7ce0-af69-7e366f226718`, against the committed M3 range
`c55d83d..7cca20b`. The CLI session was interrupted after it continued broad
searches instead of emitting the requested final ledger, but it produced the
following evidence-backed material blocker. Tier 0 must not treat this record as
an independent PASS.

## Claims ledger

| Implementer claim | Evidence checked | Auditor verdict |
|---|---|---|
| Chat and cascaded voice consume a correctly scoped canonical artifact before provider calls | `gateway/server.js:2252-2260` builds caller-branch context before the model/tool decision at `gateway/server.js:2311-2319`; cascaded voice does the same at `gateway/server.js:10849-10857` before `gateway/server.js:10971-10976` | **refuted — repair required** |
| A new or incognito thread is cold except for standing facts | HTTP voice resolves the filing action at `gateway/server.js:6345-6358`, but still builds retrieval from the caller branch at `gateway/server.js:6575-6582`; `reference/openspec/changes/context-thread-management/specs/context-thread-management/spec.md:60-65` requires new/incognito threads to load standing facts, not caller recency | **refuted — block** |
| Privacy and artifact-module bounds/redaction are covered by measured gates | Focused 17/17, locked quality maximum complexity 10 / CRAP 11.896296, strict OpenSpec valid, full gateway 189 pass / 1 skip / 0 fail, all reproduced by the manager before audit | **verified for the measured corpus; insufficient to clear the sequencing blocker** |

## Overall verdict

**BLOCK — revised architecture contract required.**

The current contract does not specify how a model-selected `new` or `incognito`
decision can occur before the answer-provider receives retrieval while retaining
the existing single tool-loop behavior. A repair may require a decision preflight,
dynamic tool-loop context replacement, or a deliberate restriction of model
overrides. Those choices change provider-call count, latency, cost, and behavior;
the M3 implementer must not choose among them silently.

No paid benchmark, external evaluation, preview, live call, or deployment was
run. The green numbers above are local measured test/quality results only.

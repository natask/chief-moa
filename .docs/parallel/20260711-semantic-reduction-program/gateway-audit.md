# Gateway semantic-reduction audit

## Scope and measurement

This is a read-only audit of gateway implementation at `516753d`. It excludes tests, smoke/eval scripts, documentation, JSON/config, generated dependencies, and blank/comment-only lines. It includes the deployable Node server, `lib`, migrations, served HTML, and the Cloudflare proxy. `scc --by-file --format csv` measured:

| Area | Production code lines | Share |
|---|---:|---:|
| `gateway/server.js` | 13,680 | 42.0% |
| `gateway/lib/*.js` | 17,281 | 53.1% |
| served HTML | 1,195 | 3.7% |
| migrations | 355 | 1.1% |
| Cloudflare proxy/config | 31 | 0.1% |
| **Total** | **32,542** | **100%** |

This number is the useful gateway baseline; the earlier 90,399 figure was repository-wide and mixed implementation with unrelated surfaces. Tests may grow without counting against the reduction objective. Reduction means removing behavior or unifying implementations, not compressing formatting or making code harder to inspect.

Largest production files:

| File | Code lines | scc complexity |
|---|---:|---:|
| `server.js` | 13,680 | 1,888 |
| `lib/voice-providers.js` | 3,164 | 709 |
| `lib/voice-session-server.js` | 1,627 | 411 |
| `lib/account-connections.js` | 1,126 | 197 |
| `lib/work-history.js` | 1,012 | 224 |
| `lib/companion-catalog.js` | 985 | 250 |
| `lib/agent-profile.js` | 847 | 247 |
| `lib/relational-store.js` | 743 | 259 |
| `lib/voice-intent.js` | 703 | 193 |
| `lib/profile-options.js` | 602 | 98 |
| `lib/browser-agent-loop.js` | 544 | 148 |

The largest coherent functions/classes identified by static boundaries include `VoiceSessionConnection` (~1,342 physical lines), `CascadedVoiceProvider` (~1,168), `GeminiLiveVoiceProvider` (~1,078), `createAccountConnectionStore` (~1,006), `createWorkHistoryStore` (~921), `createAgentProfileStore` (~339), `handleVoiceTurn` (355), and `recordStreamingVoiceTurn` (275). Approximate class spans include intervening helpers and are prioritization signals, not exact executable LOC.

## Evidence hierarchy required before deletion

1. **Tier 0: invariants/static contracts.** Syntax, dependency graph, route manifest, schema compatibility, no raw credential exposure, proposal-only actions.
2. **Tier 1: deterministic unit/contract tests.** Pure parsers, normalization, provider adapters, state transitions, serialized event/HTTP/WebSocket shapes. These are the minimum merge gate.
3. **Tier 2: isolated component tests.** Real server on an ephemeral port and temporary `DATA_DIR`; fake providers and fake clocks; golden request/event/record captures. No production data.
4. **Tier 3: cross-surface replay.** Re-run a scrubbed corpus of Android/browser HTTP and WebSocket sessions against old and candidate builds and compare semantic outputs, durable state, error endings, latency, allocations, and event counts. Audio may use deterministic fixtures/hashes.
5. **Tier 4: isolated preview runtime.** Separate URL/database/storage/worker pool; loopback/fake providers first, then explicitly approved paid-provider canaries. Capture p50/p95 time-to-first-event, completion latency, RSS, CPU, DB calls, emitted bytes, and failure completion rate.
6. **Tier 5: production shadow/canary and rollback proof.** Read-only/shadow traffic where possible, backup plus restore drill, old/new schema compatibility, no active voice/run interruption, then stable-URL promotion.

No candidate below is safe merely because current smoke scripts pass. Preserve outcomes and wire/state contracts; do not preserve internal branches by default.

## Duplication, dead paths, and structural findings

- `lib/relational-store.js` is **not imported by the running server**. Repository references are the import utility, its integration test, and the smoke manifest. It is a migration tool, not runtime implementation. Counting it as deployable production adds 743 lines and a security-sensitive second persistence mapping.
- The server maintains two browser job systems: legacy `/v1/browser/tasks` backed by hand-written file functions in `server.js` (`createBrowserTask` around line 12969) and `/v1/browser/agent-tasks` backed by `browser-agent-loop.js`. Both expose list/create/claim/update lifecycles.
- Persistence is fragmented across many bespoke JSON/JSONL stores while remote mode requires Postgres: conversations, chat turns, voice turns, provider events, browser tasks/evidence, device clients, tool requests, broker events/context packs/reports, projects, profile history, frames, agent runs, plus JSON implementations inside work graph/event substrate. This duplicates identifiers, atomic-write helpers, list/filter logic, sanitizers, limits, and retention behavior.
- Static name analysis found six `sanitizeId`, six `clampLimit`, five `cleanError`, three `cleanToken`, three `cleanText`, and repeated JSONL readers/pool factories. The raw utility saving is small; the important issue is inconsistent boundary behavior.
- `server.js` has roughly 100 route predicates in one hand-written chain and also delegates account and work-history subrouters. Authentication, parsing, error translation, and path extraction are repeated.
- Model tool execution exists in OpenAI-compatible and Vertex forms, each with streaming and non-streaming round implementations (`openAiToolLoop`, `vertexToolLoop`, `openAiToolLoopStreaming`, `vertexToolLoopStreaming`, and four round helpers). The protocol differs; the state machine does not need to.
- Voice retains cascaded Chirp/reasoner/TTS plus Gemini Developer Live and Vertex Live implementations, transport loopback, provider-package aliases, and the legacy transcript-to-device-TTS behavior. Product docs call cascaded primary and Live switchable legacy, but other active specs still require provider independence and Live continuity. Retirement requires a product decision and evidence, not an opportunistic deletion.
- `/v1/chat`, `/v1/browser/turns`, `/v1/voice/turns`, streamed voice reasoning, and internal LiveKit reason/synthesize/record routes share context assembly, model invocation, profile tooling, persistence, and product-event duties through different orchestration paths.
- Companion and pet APIs expose parallel catalog/create/preview/apply shapes plus adapters (`companionInputFromPetBody`, `companionPetRecord`). This is compatibility duplication around one underlying customization concept.
- Work graph, event substrate, work history, agent runs, broker events, and worker-pull each model overlapping task/run/event lifecycle concepts. They are not safely interchangeable today, but continuing to add bridges will expand code faster than local refactors can reduce it.
- Adding a general web framework would mostly move the route chain into dependencies and increase supply-chain/security burden. A tiny internal route table and shared request helpers can remove code without a new dependency. Likewise, adding an ORM now would not reduce the coexistence of bespoke stores; first select one canonical state model.

## Ordered reduction portfolio

Savings are production-code estimates after replacement code, expressed as ranges to avoid false precision.

### G1 — Reclassify or remove the unused runtime relational store

- **Estimated saving:** 650–743 deployable production LOC (2.0–2.3% of gateway). If the one-shot importer remains supported, move the module under `scripts/import-datadir/` and exclude tools from production accounting/artifacts; true repository deletion is possible after migration completion.
- **Files/interfaces:** `lib/relational-store.js`, `scripts/import-datadir.js`, integration tests, Docker/deploy copy lists. No live route imports it.
- **Risk:** losing the supported JSON-to-Postgres import/rollback path; this cannot be removed before backup/restore requirements have another proven mechanism.
- **Required evidence:** Tier 0 import graph and deployment artifact inventory; Tier 1 row/event mapping tests; Tier 2 import a synthetic old-data fixture into ephemeral Postgres and compare counts/content; Tier 4 backup/restore preview drill. Retain as a tool until that passes.
- **Performance:** no runtime change if merely reclassified; deleting after migration reduces artifact size and vulnerable SQL surface.
- **Confidence:** **high** for reclassification, **medium** for deletion.

### G2 — Delete the legacy browser-task queue after compatibility telemetry

- **Estimated saving:** 300–500 LOC.
- **Files/interfaces:** `server.js` routes `/v1/browser/tasks*`, helpers near `createBrowserTask`/`listBrowserTasks`; canonical replacement `/v1/browser/agent-tasks*` and `lib/browser-agent-loop.js`; browser/Android callers must be inventoried.
- **Risk:** older extension clients may still claim the legacy endpoint or depend on its record shape.
- **Required evidence:** Tier 0 client endpoint search and route-access telemetry; Tier 1 golden translation for legacy request/status into canonical task; Tier 2 old-client fixture against a temporary server; Tier 3 scrubbed task create/claim/complete replay; Tier 4 preview with both endpoints temporarily instrumented. Use a short adapter/deprecation window, then delete it.
- **Performance:** fewer directory scans and duplicate writes; canonical loop may add model-step work only when the adapter incorrectly changes semantics, which tests must prevent.
- **Confidence:** **high** that duplication exists; **medium-high** on savings.

### G3 — One model tool-loop state machine with provider codecs

- **Estimated saving:** 350–650 LOC.
- **Files/interfaces:** `server.js` functions `callModelToolLoop*`, `openAiToolLoop*`, `vertexToolLoop*`, `openAi*Round`, `vertex*Round`, tool result/action contract. Keep provider-specific encode/decode/fetch codecs.
- **Risk:** streaming deltas, tool-call replay, retry/fallback, usage accounting, and error completion subtly differ by provider.
- **Required evidence:** Tier 1 table-driven traces for plain answer, one/multiple tool rounds, malformed tool args, max rounds, SSE fragmentation, zero-delta fallback, abort/timeout; Tier 2 fake OpenAI and Vertex HTTP servers with golden emitted deltas and final actions; Tier 3 recorded scrubbed protocol replays; Tier 4 latency/RSS comparison.
- **Performance:** should reduce allocations and duplicated fallback calls if the normalized state machine streams incrementally; reject a refactor that materially worsens TTFT or buffers whole SSE bodies.
- **Confidence:** **medium-high**.

### G4 — Canonical turn application service for text/browser/voice

- **Estimated saving:** 700–1,300 LOC.
- **Files/interfaces:** `server.js` `handleChat`, browser-turn builders/completion, `handleVoiceTurn`, `runCascadedVoiceReasoning*`, context/profile/tool application, turn record/product-event helpers; `voice-router.js`; preserve all public HTTP/WS payloads.
- **Risk:** highest behavioral risk: browser evidence gating, profile controls, action-proposal boundary, incomplete voice persistence, exact transcript provenance, and agent dispatch ordering.
- **Required evidence:** Tier 1 transition matrices for every classification and error; Tier 2 golden API and durable-record snapshots with fake model/tools; Tier 3 old-vs-new replay corpus spanning typed chat, browser evidence, profile update/revert, action proposal/rejection, no-speech, interruption, timeout, and multi-agent dispatch; Tier 4 preview latency/event cardinality; Tier 5 canary plus rollback.
- **Performance:** one context load and one persistence transaction per turn should reduce filesystem/DB calls and duplicate model work. Gate on non-regression in TTFT and p95 completion.
- **Confidence:** **medium**; execute only after the replay harness exists.

### G5 — Replace hand-written route chain with a small route table

- **Estimated saving:** 350–700 LOC.
- **Files/interfaces:** `server.js` request handler lines ~429–1789; shared auth/body/error/status wrappers; account/work-history subrouters. No framework dependency required.
- **Risk:** route ordering and prefix extraction, public-vs-protected endpoints, body limits (especially audio), response headers, and 404/error shape.
- **Required evidence:** generated Tier 1 route manifest asserting method/path/auth/body-limit/handler; Tier 2 exhaustive endpoint contract matrix against ephemeral server, including wrong method, missing token, oversized body, malformed JSON, and prefix IDs; Tier 3 client smoke replays.
- **Performance:** a compiled literal/prefix table is neutral or faster than ~100 sequential predicates; measure router microbenchmark and end-to-end p95. Avoid regex-heavy routing.
- **Confidence:** **high**.

### G6 — Canonical persistence/event repository; retire bespoke remote stores

- **Estimated saving:** 1,500–3,000 LOC initially; potentially 4,000+ after all migration adapters expire.
- **Files/interfaces:** `server.js` file paths and CRUD helpers; `event-substrate.js`, `work-graph.js`, `work-graph-postgres.js`, `work-history.js`, `thread-store.js`, `browser-agent-loop.js`, worker/tool/run stores, schema/migrations. Canonical remote target should be Postgres plus object/blob storage; local development gets one generic file adapter, not one store per feature.
- **Risk:** data loss, ordering/idempotency regression, old/new deployment incompatibility, broken restore, and increased local setup burden. This is a staged migration, never a single rewrite.
- **Required evidence:** Tier 0 ownership/schema map; Tier 1 repository contract suite run against both adapters; Tier 2 synthetic migration/backfill repeated twice (idempotency), crash-at-every-step tests, and old/new dual-read/write compatibility; Tier 3 scrubbed state replay and event-count/hash comparison; Tier 4 isolated database/blob preview with backup and scratch restore; Tier 5 dual-write verification before read switch and rollback.
- **Performance:** expected large reduction in sync filesystem scans and whole-file rewrites; require query-count budgets, indexed p95 reads, write throughput, storage growth, and connection-pool bounds. Do not accept an event-scan projection that makes common reads O(history).
- **Confidence:** **medium** on initial savings, **high** that this is the largest sustainable reduction.

### G7 — Collapse companion/pet compatibility surfaces

- **Estimated saving:** 250–450 LOC after client migration.
- **Files/interfaces:** `server.js` `/v1/agent/companions*` and `/v1/agent/pets*`, conversion helpers, `lib/companion-catalog.js`; choose a canonical `companions` resource with pet-specific presentation fields or the reverse.
- **Risk:** website/extension profile studio compatibility, saved manifest versions, preview/apply semantics, and voice binding.
- **Required evidence:** Tier 0 caller and stored-version inventory; Tier 1 round-trip conversion/golden manifests; Tier 2 old/new API compatibility adapter; Tier 3 studio create-preview-apply replay; Tier 4 separate-storage preview.
- **Performance:** fewer catalog reads/conversions and less duplicate validation; image-generation latency remains unchanged.
- **Confidence:** **medium-high**.

### G8 — Retire one native Live provider or the entire legacy-live lane only by product decision

- **Estimated saving:** 700–1,400 LOC for one provider/auth duplication; 1,300–2,200 LOC if native Live is removed while retaining loopback transport and cascaded voice.
- **Files/interfaces:** `lib/voice-providers.js` `GeminiLiveVoiceProvider` and Vertex auth/endpoint helpers; registry/env aliases; related setup/docs. `voice-session-server.js` remains for cascaded WebSocket transport.
- **Risk:** loses native duplex audio, provider failover, current verified Vertex path, interruption/continuity behavior, or customers configured for Developer Live. Active OpenSpec explicitly preserves provider independence, so this requires superseding product/spec approval.
- **Required evidence:** usage/config telemetry without secrets; Tier 1 registry and unsupported-config errors; Tier 2 equivalent cascaded tests for interrupt, barge-in, partial transcript, audio queue, language/profile tools; Tier 3 same utterance/capture corpus scored for task success and response quality; Tier 4 approved provider A/B measuring word error rate, completion, TTFT, full latency, TTS failure, and cost; migration/rollback plan.
- **Performance:** cascaded often has higher end-to-end latency but can pipeline TTS; native Live may have lower conversational latency. Do not trade measured task success or latency for LOC silently.
- **Confidence:** **low** without usage/product evidence; potentially the largest voice deletion.

### G9 — Merge overlapping work lifecycle models around canonical events

- **Estimated saving:** 800–1,800 LOC after adapters expire.
- **Files/interfaces:** `work-history.js`, `work-graph*.js`, agent-run and broker helpers in `server.js`, `worker-pull.js`; define one task/run/control/deployment vocabulary and projections.
- **Risk:** these models currently encode distinct semantics (tree corrections/queue, voice history controls, harness process lifecycle, broker routing). A naïve generic CRUD abstraction would hide differences without reducing behavior.
- **Required evidence:** Tier 0 semantic mapping and non-goals; Tier 1 lifecycle state-machine/property tests; Tier 2 projection/rebuild tests; Tier 3 full create-route-claim-run-feedback-deploy replay; Tier 4 DB query/event budgets and worker lease race tests.
- **Performance:** one append plus indexed projections can replace several writes, but projection rebuild and claim locking must stay bounded.
- **Confidence:** **medium-low** until the event vocabulary is contracted.

### G10 — Centralize boundary primitives during the above work

- **Estimated saving:** 150–300 LOC, secondary to correctness.
- **Files/interfaces:** repeated `sanitizeId`, `clampLimit`, `cleanError`, JSONL/pool helpers across `server.js` and `lib`; expose a deliberately tiny internal boundary module.
- **Risk:** changing accepted IDs, truncation, error redaction, or numeric defaults globally.
- **Required evidence:** Tier 1 characterization tables for every current caller before consolidation; security cases for path traversal/control characters/secret-bearing errors; Tier 2 route snapshots.
- **Performance:** neutral; fewer repeated parses. Do not create a broad “utils” dumping ground.
- **Confidence:** **high**, but low leverage.

## Recommended program and target

Do not start with G6/G9. First build the Tier 1–3 behavior harness and runtime metric capture. Then execute G1, G2, G3, G5, G7, and G10 as narrow independently revertible slices. Those have a realistic combined net reduction of **2,750–5,343 production LOC** (8–16%) without intentionally removing user capability. After the canonical-turn and persistence migrations (G4/G6) prove compatibility, the cumulative target becomes roughly **5,000–9,000 LOC** (15–28%). Provider/lifecycle retirement can exceed that, but only with product and observed-usage evidence.

Quality gates should be semantic: task-success parity, exact API/event/state compatibility where promised, no new trust-boundary violations, no p95 latency/RSS/DB-call regression beyond an agreed budget, and clean rollback. “Tests pass” alone is inadequate if the tests only mirror implementation branches.

## Verification performed and limitations

- Static production measurement: `scc --by-file --format csv gateway/server.js gateway/lib gateway/migrations gateway/public gateway/deploy/cloudflare-api-proxy`.
- Import/reference searches established that `relational-store.js` is absent from runtime imports and that two browser task route families coexist.
- Function/class and repeated-helper inventories were generated read-only from source.
- `npm run check` was attempted with `MOA_SKIP_SLOW=1`. It could not be treated as a baseline pass because this worktree has no installed `pg` dependency (`MODULE_NOT_FOUND`). Five manifest smokes shown before truncation passed (`voice-intent`, `voice-router`, `language-allowlist`, `page-tweaks`, `presentation`, plus work-graph/work-history-intent); dependent server smokes failed to boot. No dependency installation was performed because this audit is read-only and lockfile-consistent installation belongs to the orchestrated verification lane.
- No provider sockets, paid APIs, production endpoints/data, restarts, deploys, or mutations were used.

# Semantic reduction roadmap

## Entry gate: repair the oracle before deleting code

No production reduction branch starts until the baseline is reproducible in a clean isolated worktree.

1. Run `npm ci` from the gateway lockfile and repair the missing-`pg` clean-worktree gate without weakening tests.
2. Repair or characterize the browser shortcut smoke's unexpected cancel/new-session sequence. Preserve the assertion unless the product contract changes explicitly.
3. Check in the frozen production/test/generated/config/docs classifier and audit the current `other` category once.
4. Add a hermetic gateway runner: temporary `DATA_DIR`, random port, fake/loopback providers, disposable Postgres provision/destruction, fixed seed and cleanup assertion.
5. Add the protected-behavior manifest and machine-readable scorecard.
6. Add Level-4 journeys for browser voice, Android fake phone action/approval/receipt and cross-client interrupted-turn resume.
7. Establish sanitized replay format and JSON performance/resource capture. Do not read or enumerate production content; fixtures require explicit provenance and scrubbing.

**Production LOC target:** 0. Tests may grow freely. **Gate:** all feasible Levels 1–4 green, baseline metrics captured, zero active/live mutation. **Rollback:** test-only commits revert independently.

## Common acceptance gates

Every slice reports production semantic LOC before/after using the frozen classifier and tests separately. It must pass the highest feasible cumulative evidence levels:

- L1 unit/contract invariants;
- L2 component with fake boundaries;
- L3 real protocol/storage with fake paid providers and isolated state;
- L4 real client-to-isolated-gateway journey and durable-result query;
- L5 sanitized offline runtime replay;
- L6 guarded canary only when retiring an observed compatibility path.

Performance uses identical machine/runtime/seed/warm policy and at least 20 runs: candidate p95 may not regress by more than 5% or 20 ms, CPU by more than 5%, memory by more than 5% or 10 MiB, and must show no monotonic growth over 100 turns. Resource-specific gates assert one active mic/socket/playback graph, bounded timers/queues, no extra polling, query-count budgets and indexed store reads. Flake gate is zero failures over at least 50 deterministic repetitions.

Every deployable slice remains on an isolated branch/worktree and preview URL/state. Promotion needs verification, preview smoke, backup/restore evidence for persisted state, old/new compatibility, known rollback, and proof no recording/session/run/job is interrupted.

## Wave 1 — high-confidence deletion and local consolidation

Wave 1 begins only after the entry gate. Slices are deliberately disjoint and independently revertible.

| Slice | Owned production files | Dependency | Net production target | Evidence/performance | Rollback |
|---|---|---|---:|---|---|
| W1-A browser duplicate validators | `browser_extension/extension/content.js`, `ui-spec-runtime.js`, `stop-intent.js`, `manifest.json` | baseline browser traces | −180 to −260 | L1 adversarial corpus; L3 reinjection/stop traces; L4 DOM/runtime errors; no extra messages/listeners | restore copied functions and manifest order |
| W1-B gateway migration-tool reclassification | deployment artifact/copy manifests; `gateway/lib/relational-store.js` only if moved intact under import tooling | artifact inventory and restore drill | **0 true deletion**, −650 to −743 runtime-classified LOC | import synthetic old state into disposable Postgres; identical rows/events; backup/restore proof | include prior module path/artifact again |
| W1-C gateway boundary primitives | new narrow internal boundary module plus caller-owned utility sections; exclude files owned by other W1 slices | characterization tables | −150 to −300 | L1 accepted/rejected IDs, limits, redacted errors, traversal/control characters; route snapshots; neutral CPU | restore caller-local helpers |
| W1-D Android overlay boundary cleanup | `OverlayService.java`, `MainActivity.java` only | Android surface policy tests | −250 to −500 initial | L1 current-intent/approval policy; L3 run completion; L4 emulator accessibility/window/frame/RSS; no polling increase | OTA/APK artifact from prior commit |

W1-B must be reported as reclassification, not product deletion. True deletion of the importer/store is deferred until another proven restore/import path exists. Do not claim savings by changing only the classifier or artifact membership.

**Wave target:** 580–1,060 true production LOC plus 650–743 reclassified runtime LOC, stated separately. W1 integration order is A, C, D; B is an operational/tooling lane and never added to true deletion totals.

## Wave 2 — compatibility adapters with caller evidence

| Slice | Owned files/interfaces | Depends on | Target | Evidence/performance | Rollback |
|---|---|---|---:|---|---|
| W2-A canonical browser gateway access | `options.js`, `background.js`, `config.js` and message contract | W1-A and worker-restart fixture | −250 to −450 | L1 error mapping; L2 auth/method/cache; L3 worker restart; L4 options states; interaction latency non-regression | retain direct adapter behind one release flag |
| W2-B browser task API convergence | gateway legacy `/v1/browser/tasks*` helpers/routes and canonical adapter; client endpoint callers | endpoint telemetry/caller inventory | −300 to −500 after adapter expiry | old-client fixture; create/claim/complete replay; route telemetry; directory scans/writes lower | restore legacy routes/store and dual-read adapter |
| W2-C companion/pet resource convergence | gateway catalog/routes/converters and website/client callers | stored-version/caller inventory | −250 to −450 after adapter expiry | manifest round trips; studio create-preview-apply L4; isolated state | keep versioned compatibility adapter |
| W2-D browser authenticated UI and gateway API integration | serial integration of A–C; no additional production ownership | all W2 slices | 0 | full browser verify/smoke and protected journeys | revert merges independently |

**Wave target after adapters expire:** 800–1,400 LOC. An adapter is not counted as deleted until telemetry shows no supported caller and the prior release remains a fast rollback.

## Wave 3 — shared state machines without product removal

| Slice | Owned files | Depends on | Target | Evidence/performance | Rollback |
|---|---|---|---:|---|---|
| W3-A gateway model tool-loop | `server.js` tool-loop/round region, provider codec tests | protocol replay harness | −350 to −650 | fragmented SSE, abort/timeout, multiple tools, zero-delta fallback; fake OpenAI/Vertex servers; TTFT and buffering gates | old loop selected by internal flag for one release |
| W3-B browser turn core | `content.js`, `sidepanel.js`, one shared runtime, relevant manifest entries | W2-A and reducer traces | −450 to −750 | terminal/recovery/revoke traces; both DOMs; timers/audio sources/sockets bounded | restore view-local cores |
| W3-C Android voice state core | `OverlayService.java`, streaming/socket/audio/voice controllers | W1-D and fake-clock callback corpus | −500 to −900 | every callback interleaving; fake socket; emulator mic/audio; one capture/socket/playback queue | prior APK/OTA plus adapter flag |
| W3-D gateway route table | `server.js` route-dispatch region only | exhaustive route manifest | −350 to −700 | every method/path/auth/body limit/error/404; router microbenchmark and HTTP p95 | restore sequential handler |

`server.js` ownership makes W3-A and W3-D serial even though their conceptual regions differ. W3-B and W3-C may run in parallel.

**Wave target:** 1,650–3,000 LOC.

## Wave 4 — canonical turn service

One gateway slice owns `server.js` turn handlers, `voice-router.js` and the narrow context/profile/tool/persistence orchestration interfaces. Client teams own only fixtures/adapters and do not edit those files concurrently.

- Preserve `/v1/chat`, browser, voice and internal route wire contracts during migration.
- Route typed, browser and voice inputs through one application service that emits a canonical turn result plus transport-specific stream/render events.
- Keep browser evidence gating, model-output-as-proposal, exact transcript provenance, incomplete-turn persistence and profile snapshot semantics explicit.
- Dual-run old/new services offline on Level-5 replays and compare semantic predicates, event partial order, durable graph, calls and latency.

**Target:** −700 to −1,300 LOC. **Dependencies:** Waves 2–3, all protected turn journeys. **Gate:** Levels 1–5, p95/CPU/RSS/query counts, exact trust and persistence scorecard. **Rollback:** one-release internal switch plus backward-compatible state; remove switch only after canary evidence.

## Wave 5 — staged persistence convergence

This is a sequence, not a rewrite:

1. Contract one repository interface per aggregate and run it against current adapters.
2. Add canonical Postgres/blob schema without removing fields or routes.
3. Dual-write old and new stores with idempotency keys; compare counts, hashes and relations.
4. Backfill with an idempotent resumable job; run twice and crash-injection tests.
5. Switch reads in isolated preview, then guarded canary, while old code can still read new writes.
6. Prove backup and scratch restore, query indexes, connection bounds and projection rebuild.
7. Remove old readers, then old writers, then files/schema only after the rollback window.
8. Replace feature-specific local stores with one conforming generic file adapter.

**Owned files:** storage helpers in `server.js`; `event-substrate.js`, `work-graph.js`, `work-graph-postgres.js`, `work-history.js`, `thread-store.js`, browser/worker/tool/run stores, schema and migrations. Freeze unrelated feature work in these files during each stage.

**Target:** −1,500 to −3,000 LOC initially; more only after adapter expiry. **Gate:** Levels 1–5, old/new compatibility, restore, exact event relationships, indexed p95 and query budget, no O(history) common read. **Rollback:** read switch back, dual-write retained, previous artifact/ref and verified restore. Never combine irreversible cleanup with the code rollout that first needs new state.

## Wave 6 — work lifecycle convergence

Define one product vocabulary for task, run, claim/lease, control/cancel, result/receipt and deployment while retaining executor-specific payloads. Converge work graph, voice work history, broker runs and worker pull as projections over canonical events. Do not build a generic CRUD abstraction that merely hides four implementations.

**Owned files:** `work-history.js`, `work-graph*.js`, `worker-pull.js`, agent-run/broker regions of `server.js`. **Dependency:** Wave 5. **Target:** −800 to −1,800 LOC. **Gate:** lifecycle property tests, lease races, correction/queue semantics, projection rebuild and full create-route-claim-run-feedback-deploy replay. **Rollback:** retain old projections and replay events into them through a compatibility release.

## Wave 7 — explicit product deletions

These are not engineering refactors. Each needs a recorded product decision, usage/capability evidence, updated OpenSpec/architecture, Level-6 canary and migration communication.

| Decision | Candidate deletion | Estimated target | Required decision evidence |
|---|---|---:|---|
| browser surface | side panel or in-page lifecycle | −500 to −850 | restricted-page access, keyboard/accessibility, persistence and usage matrix |
| gesture grammar | legacy or voice-first on both clients | −350 to −650 | task success, accidental capture, muscle-memory/canary traces; one cross-platform contract |
| Android degraded voice | platform recognizer and/or local TTS path | −300 to −750 | API/device coverage, outage behavior and success-rate comparison |
| gateway native Live | one Live provider or whole legacy-live lane | −700 to −2,200 | configured usage, English/Amharic quality, TTFT/completion/cost, duplex/interruption parity |

Rollback is the immediately prior extension package/APK/gateway ref plus backward-compatible profile/state. Do not delete multiple fallback layers in one release.

## Portfolio accounting and stop conditions

- Re-baseline after every wave; ranges overlap, especially turn, route and storage code.
- Report true deleted implementation, replacement implementation, net semantic LOC, reclassified tool LOC and expired compatibility LOC separately.
- Architecture-preserving Waves 1–4 plausibly remove about 3,700–6,760 LOC before overlap adjustment. Waves 5–6 can move the cumulative program toward roughly 6,000–11,000 net LOC. Wave 7 may increase the total only after product decisions.
- Stop a candidate when behavior success, trust, p95 latency, CPU, memory, flake rate, state compatibility or rollback evidence regresses. A lower LOC number is not compensating value.
- Do not add a framework, ORM or generated-source layer merely to export maintenance/security burden. A dependency is justified only when total owned code, vulnerabilities, runtime resources and operational complexity decrease measurably.

## Promotion order for every completed slice

Narrow verification → full affected-surface gate → independent audits → Conventional Commit → isolated preview/release artifact → backup/restore and rollback proof where stateful → no-active-work/drain proof → promote only when the repository safety gate passes → smoke the stable target. If any evidence is missing, stop at the committed artifact and record the blocker.

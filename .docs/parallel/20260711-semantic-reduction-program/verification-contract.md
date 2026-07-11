# Semantic-reduction verification contract

## Authority and parity rule

This document and `protected-behaviors.json` are the merge contract for production-code reduction. Production semantic LOC must decrease; test LOC is unrestricted and reported separately. Formatting compression, minification, generation, vendoring, file reclassification, comments, or moving behavior across surfaces do not count as savings.

For every protected behavior affected by a candidate, the authoritative parity tier is `highest_feasible_tier` in the manifest. All required tiers from 1 through that tier must pass on both baseline and candidate using identical fixtures and environment. **A pass below the highest feasible tier is never parity evidence.** A tier may be lowered only when a committed manifest change names the concrete infeasibility, evidence, owner, expiry, and independent approval before implementation. A failing or missing authoritative test blocks reduction; deletion must not weaken, delete, skip, or rewrite the oracle merely to obtain green.

Tier 6 is a release canary, not a substitute for deterministic parity. It is required only for a promoted surface and only after tiers 1–5 pass. No live, paid, sensitive, restart, reload, install, or deploy operation is authorized by this contract.

## Authoritative six-tier hierarchy

| Tier | Evidence | Required property |
|---:|---|---|
| 1 | Unit and contract | Pure transitions, parsers, sanitizers, schemas, trust rules, HTTP/WS/event shapes; deterministic and exhaustive at boundaries. |
| 2 | Component | Real Android JVM component, real extension in headless Chrome, or real gateway module with fake edges and clock. |
| 3 | Protocol/storage integration | Real ephemeral gateway, HTTP/WS/PCM, temporary file store and disposable Postgres; fake paid providers; restart and cleanup. |
| 4 | Client-to-history E2E | Real client runtime → isolated gateway → visible result/action → durable query/restart assertion. DOM-only or status-200-only evidence is insufficient. |
| 5 | Sanitized replay | Approved, scrubbed runtime-shaped corpus replayed old versus candidate; semantic/event/state/performance comparison. |
| 6 | Minimal live canary | Synthetic non-sensitive release checks after deterministic gates, operator-safe drain/rollback/backup evidence, and separate paid-provider authority. |

Feasibility means the repository and local isolated runtime can implement the test without production access or an unavailable physical capability. “The harness has not been written” means feasible and missing, not infeasible.

## Environment isolation

Every deterministic run records commit, OS/architecture, Node/JDK/Gradle/Chrome versions, fixture version, random seed, concurrency, cold/warm policy, and command exit status. It must enforce:

- `npm ci` from the committed lockfile; no inherited dependency tree.
- Fresh `mktemp -d` `DATA_DIR`, random loopback port, synthetic bearer token, and cleanup assertion.
- Remove inherited `DATABASE_URL`, provider credentials, public gateway URL, deployment variables, and user home/config paths before file-mode tests.
- Database tests receive only a run-created disposable Postgres database. The runner rejects hostnames not explicitly allowlisted as loopback/test containers, creates a unique database, migrates, runs twice where idempotency matters, drops it, and verifies removal.
- Fake local STT, OpenAI-compatible, Vertex, TTS, device, CDP, clock, and failure injectors. Network egress is denied except loopback.
- Headless Chrome gets a fresh profile directory and unpacked candidate extension. No dev reload bridge and no user Chrome profile.
- Android uses JVM tests or an isolated emulator snapshot with fake action executor, fake microphone/audio, and no real contacts, telephony, apps, or account data.
- Baseline and candidate run serially on the same machine with identical fixtures. Machine-readable results go to an ignored artifact directory; sanitized summaries alone may be committed.

The authoritative local command becomes one wrapper, proposed as `scripts/verification/run-reduction-gate.sh --baseline <sha> --candidate <sha>`. Until that wrapper exists, run the exact component commands in the manifest, but do not claim tiers 3–5 are complete merely because individual legacy smokes passed.

## Exact protected journeys

The machine-readable manifest is authoritative. In product order:

1. Browser text: preserve draft; authenticated turn; render reply/error; query canonical stored turn.
2. Browser voice: shortcut and mark start/commit/hold; partial→final transcript; ordered audio/done; query stored turn.
3. Android voice: gesture/capture/commit; transcript/reply/audio; interruption; query and resume.
4. Phone action: gateway proposal only; Android validation/approval; exactly-once fake execution; receipt/history; malformed or stale proposals rejected.
5. Browser page action: bounded declarative tweak or claimed CDP task; local allowlist; observable page result; evidence/history; arbitrary code rejected.
6. Persistence/resume: completed and interrupted turns retain provenance/partial context/profile version through restart and cross-client resume.
7. Failure diagnosis: injected capture, transport, STT, context, reasoning, TTS, playback, and storage faults produce conservative phase, visible fallback, and evidence refs.
8. Profile/language/sample: sanitized versioned update/revert, admitted-turn snapshot, next-turn application, and sampling without saved-profile mutation.
9. Work lifecycle/history: create/route/claim/status/cancel/feedback and durable query without stranding an active run.
10. API/trust compatibility: method/path/auth/body limits/error shape, no credentials in clients, proposal-only local execution.

## Sanitized capture schema

Each Level-5 fixture is one JSON object conforming to this logical schema:

```json
{
  "schema_version": 1,
  "fixture_id": "synthetic-stable-id",
  "provenance": {
    "kind": "synthetic|consented-runtime",
    "consent_ref": "required-for-runtime-only",
    "captured_at_bucket": "YYYY-MM",
    "reviewed_by": ["two reviewers for runtime captures"],
    "raw_expires_at": "date outside git",
    "sanitizer_version": "sha256"
  },
  "surface": "android|browser|gateway",
  "journey": "protected behavior id",
  "input": {
    "audio_fixture": "synthetic path or null",
    "audio_sha256": "hash or null",
    "duration_bucket_ms": "coarse bucket or null",
    "approved_text": "synthetic/explicitly approved only",
    "semantic_predicates": ["stable assertions"]
  },
  "events": [{
    "ordinal": 1,
    "type": "normalized event",
    "phase": "capture|transport|stt|context|reasoning|tts|playback|storage",
    "status": "started|partial|complete|failed",
    "size_bucket": "optional",
    "relation_aliases": ["session-1", "turn-1"]
  }],
  "expected": {
    "result_type": "reply|action|rejection|error",
    "required_relations": ["turn-1 belongs-to session-1"],
    "action": {"kind": "bounded kind or null", "decision": "approve|reject|none", "executor_calls": 0},
    "diagnosis_phase": "phase or null",
    "event_partial_order": [["transcript_final", "turn_done"]]
  }
}
```

Before commit, replace account/user/device/session/branch/turn IDs with deterministic aliases; remove tokens, headers, URLs, prompts, page/contact/file text, provider-native payloads, precise timestamps, and raw user text. Audio requires explicit consent; otherwise store format/duration/hash metadata and use synthetic replacement. Run secret/PII scanning and two-person review. Raw captures remain outside Git with access control and expiry. Never enumerate production history to obtain fixtures; export only an explicitly approved turn ID.

## Before/after scorecard

Each run emits one JSON row per behavior for baseline and candidate:

| Dimension | Measurement | Acceptance |
|---|---|---|
| Semantic output | normalized result, transcript predicates, visible result, audio order | exact protected predicates; no final transcript loss |
| Trust/action | proposal, policy, approval, executor count, receipt linkage, rejection matrix | exact match; zero unapproved execution |
| Persistence | required entities/relations before and after restart | exact fields/relations; partial interrupted turn retained |
| Diagnosis | injected versus attributed phase, fallback, evidence refs | 100% matrix; no silent terminal failure |
| Latency | capture→partial, commit→final, first event/audio, completion p50/p95 | p95 not worse by more than max(5%, 20 ms), and product budget met |
| CPU | process CPU per fixed warm journey and idle | no regression above 5% over at least 20 runs |
| Memory | baseline/peak/post-idle RSS and 100-turn slope | no regression above max(5%, 10 MiB); no monotonic leak |
| I/O | DB queries, file operations, bytes/events | no unexplained increase; candidate must meet journey-specific budget |
| Flake | seeded failures over at least 50 deterministic repetitions | zero merge failures and not worse than baseline |
| Production semantic LOC | frozen `scc` tracked-file classifier | strictly lower; test LOC separately reported |

A candidate passes only if every affected manifest item is `PASS` at its authoritative tier and all lower tiers, scorecard thresholds pass, production LOC decreases, and no behavior is marked `missing` or `blocked`.

## Blocker diagnoses and minimal repair tickets

### B1 — extension shortcut smoke double-toggle

Observed evidence: `npm run verify` passed, but `npm run smoke` failed. In the first supposed quick tap, captured calls already contained `voiceSessionStart`, `voiceSessionAttach`, and `commit_turn`; `tapStarted.listening` was false. The test expected one start and listening=true until the second tap. `content.js` has two ingress paths for the same registered shortcut: the page-level `keydown` handler calls `beginVoiceHotkey`, while the background command sends `toggleVoice` and calls `beginVoiceCommandHotkey`. Dedupe state exists, but the observed trace proves the assembled Chrome path still toggles twice in this harness. The smoke also sleeps after dispatching `keyup`, so its `holdMs` argument does not model key-down duration; this makes its naming misleading, although the separate 340 ms hold does wait between down/up. AudioContext autoplay warnings are expected in synthetic events and are not the assertion failure.

Smallest repair ticket, owner `browser-voice-verification`:

- Touch only the shortcut test harness first. Record each ingress (`page-keydown`, `chrome-command`) and monotonic timestamp, and drive page-only and command-only cases separately so exactly one ingress is expected per case.
- Add a combined real-Chrome case proving dedupe produces one state transition when both ingress paths fire. Assert transition sequence, not cumulative mutable call arrays.
- If combined case still duplicates, a second narrowly scoped production ticket may change only shortcut dedupe/ownership in `content.js`/`background.js`, with default and voice-first mappings characterized first.
- Acceptance: 50 seeded repetitions of quick start, quick commit, hold commit, command hold, Meta/Control release, blur cancel, and draft preservation; zero duplicate start/commit/cancel; `npm run verify && npm run smoke` green.
- Do not “repair” by deleting the assertion, increasing arbitrary sleeps, or disabling one supported shortcut path without product approval.

### B2 — clean-worktree `pg` failure

Observed evidence: `gateway/package.json` declares `pg ^8.22.0`, and `package-lock.json` locks `pg 8.22.0`. The worktree had no `gateway/node_modules`, so `npm run check` failed with `MODULE_NOT_FOUND`. Both integration files require `pg` at module top level before `describe(... {skip})`; thus even without a database URL, dependency absence fails discovery instead of skipping. This is not a missing manifest dependency and not an application regression. It is an unprepared worktree plus a check UX issue.

Smallest repair tickets, owner `gateway-verification`:

1. Runner ticket: execute `npm ci` before checks, verify `npm ls pg`, and keep `node_modules` generated/ignored. Acceptance: a new clean worktree reaches tests using only lockfile dependencies.
2. Optional test-UX ticket: move database-only imports behind the database availability branch or split integration discovery from the default check, while keeping a required CI job that installs dependencies and runs disposable-Postgres integration. Acceptance: dependency absence yields an explicit prerequisite failure from the wrapper, never dozens of misleading smoke failures; database tests cannot silently disappear from CI.

Do not remove `pg`, weaken integration coverage, inherit another worktree's `node_modules`, or point tests at production.

## Repair and implementation order

1. B2 runner: hermetic `npm ci`, environment scrub, fake-provider/temporary-state wrapper, disposable Postgres guard.
2. B1 harness characterization and deterministic shortcut repair; freeze its golden transitions.
3. Implement the protected-behavior manifest runner and machine-readable scorecard; make missing highest-tier evidence a hard failure.
4. Build Tier-3 fixtures for protocol/storage/failure injection and run baseline until green.
5. Build Tier-4 browser voice, Android action/receipt, and cross-client resume journeys.
6. Create synthetic Level-5 fixtures; add consented runtime captures only after sanitation review machinery exists.
7. Capture stable baseline performance/flake distributions.
8. Only then begin low-risk reduction slices. Each slice declares affected behavior IDs before editing and runs their authoritative tiers after editing.
9. Structural turn/persistence/provider reductions wait for all related Tier-4/5 evidence. Live canaries and promotion remain a separate release gate.

## Current status

- Android Tier 1/2: `testDebugUnitTest` passed in the baseline lane.
- Browser Tier 2 static/component: `npm run verify` passed, sampler lifecycle 7/7; shortcut assembled smoke blocked by B1.
- Gateway deterministic gate: blocked before authoritative result by B2. Some dependency-light scripts passed, which is explicitly insufficient parity evidence.
- Tiers 3–5 are incomplete as an authoritative unified harness. No reduction candidate may claim full behavioral parity yet.
- No live service, paid provider, sensitive content, deployment, restart, extension reload, or phone install was used.


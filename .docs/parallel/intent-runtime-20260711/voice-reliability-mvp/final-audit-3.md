# Final independent audit 3: voice reliability timeline MVP

## Verdict

**BLOCK**

The second repair makes timeline ordering deterministic, transitive, and
consistent with admitted same-clock endpoint causality. It also preserves the
real three-state diagnosis proof, exact endpoint/calibration authority, frozen
outputs, and `O(n log n)` bounded-record ordering. The candidate is still not
ready to commit because two privacy gaps and two resource-bound violations
remain in the production exports.

No implementation, route, store, browser, Android, active tree, commit, merge,
preview, or deployment surface was edited by this audit.

## Blocking findings

### 1. Composed content names bypass the recursive metadata-only policy

The sensitive-key vocabulary lists standalone `transcript`, `text`, `prompt`,
`content`, `completion`, and `message` names
(`gateway/lib/voice-reliability-timeline.js:125-189`), but those nouns are not
treated as sensitive segments in composed normalized keys (`:190-210` and
`:843-877`). The audio path guard recognizes only an exact `audio` segment or a
segment ending in `_audio` (`:801-815`), so names beginning with or containing
an audio namespace also escape it.

An independent production-export probe passed every one of these fields through
`recordsFromVoiceDiagnosis`:

```text
DIAG_ACCEPT userTranscript
DIAG_ACCEPT assistantText
DIAG_ACCEPT systemPrompt
DIAG_ACCEPT modelContent
DIAG_ACCEPT completionText
DIAG_ACCEPT userMessage
DIAG_ACCEPT audioSamples
DIAG_ACCEPT audioContent
DIAG_ACCEPT audioFrames
DIAG_ACCEPT assistantAudioSamples
```

The projection currently ignores those values, but the contract explicitly
requires raw voice/model content to be rejected recursively before projection;
accepting it also makes this scanner unsafe to reuse at the later ingestion
boundary. Normalize content nouns wherever they occur in a key/path, and admit
only explicit bounded metadata exceptions such as `transcript_chars` and
`audio_bytes` rather than allowing arbitrary composed names. Add camel, snake,
kebab, whitespace, and punctuation variants without breaking the six current
sanitized diagnosis fixtures.

### 2. Common credential values and credential-shaped IDs still pass

The value detector at `gateway/lib/voice-reliability-timeline.js:19-35` covers
the named API/access/refresh/client-secret, Slack, SendGrid, GitHub/GitLab, AWS
ID, npm, Stripe key, bearer/JWT, and private-key probes from repair 2. It does
not cover several names that the key policy itself declares sensitive,
including password, generic secret, session token, and ID token values, nor the
common Stripe webhook-secret prefix. `exactId` relies on this same incomplete
detector (`:997-1005`).

Independent probes accepted each string both as an otherwise ignored diagnosis
value and as `event_id`:

```text
password_abcdefghijklmnop
secret_abcdefghijklmnop
session_token_abcdefghijklmnop
id_token_abcdefghijklmnop
whsec_abcdefghijklmnop
```

Reserve the full normalized credential-family prefixes in opaque IDs and extend
the value detector consistently. Preserve explicitly redacted forms such as
`Bearer [redacted]` and `api_key_[redacted]`.

### 3. The array item cap runs after materializing every descriptor

`walkBoundedData` calls `assertOrdinaryDataArray` before checking
`value.length > MAX_WALK_NODES`
(`gateway/lib/voice-reliability-timeline.js:914-920`). That helper first calls
`Object.getOwnPropertyDescriptors` and scans every array entry (`:935-963`). An
oversized dense array therefore allocates and traverses attacker-selected work
before the advertised 4,096-node/item bound rejects it.

One isolated process probe showed the scaling (the heap numbers are diagnostic,
not production performance claims):

```text
size=4097    rejected after 1.613 ms, heap delta 1,075,384 bytes
size=100000  rejected after 27.679 ms, heap delta 18,676,448 bytes
```

Read and validate the ordinary own `length` descriptor and apply the item cap
before materializing indexed descriptors. Only then perform the exact
prototype/symbol/hole/accessor/data-entry checks. Add a large dense-array
regression that proves bounded pre-rejection work without weakening the current
zero-side-effect hostile-array tests.

### 4. The advertised byte limits are approximate and can be exceeded

The recursive byte walker counts array/object delimiters but not commas between
entries (`gateway/lib/voice-reliability-timeline.js:914-932`) and assigns a
fixed 16 bytes to every number (`:902-905`) rather than its exact JSON encoding.
Consequently the stated byte caps are not exact.

Two independent accepted probes demonstrate the boundary violation:

```text
recordsFromVoiceDiagnosis:
  encoded input 131,302 bytes > 131,072-byte diagnosis limit -> accepted

endpointPlaybackAttribution:
  encoded input 527,390 bytes > 524,288-byte timeline limit -> accepted
```

Both used ordinary own-data arrays/objects and safe strings; neither depended on
accessors, exotic prototypes, proxies, or cycles. The attribution-time padding
was ignored and did not forge its result, but it still bypassed the resource
admission contract. Compute exact bounded JSON bytes from already validated own
data, including separators and exact primitive encodings, and add exact-limit
plus limit+1 regressions for every exported ingest shape.

## Repaired behavior independently verified

- The former cyclic example (receipt wall `3000`/mono `100`, playout wall
  `1000`/mono `200`, server wall `2000`) produced one order across all six
  permutations:

  ```text
  server write -> endpoint receipt -> endpoint playout
  ```

  The isotonic construction at
  `gateway/lib/voice-reliability-timeline.js:666-718` precomputes a navigation
  key per exact source/observer/surface/clock domain and then applies one total
  tuple. It does not reintroduce a pair-dependent comparator.
- Three independently generated 256-record permutations produced byte-identical
  timelines. A comparison-count probe over a scrambled 256-record exact-clock
  group observed 3,112 sort comparisons; static inspection confirms group sorts
  plus one global sort, with total group membership linear. No topological
  rescan or receipt/playout cross product exists.
- Exact same-session, same-turn, same-observer, and same-clock joins remain
  enforced. Orphan and foreign calibrations fail; multiple matching calibration
  samples retain the complete uncertainty envelope; durations subtract only the
  single receipt/playout pair on the same endpoint clock.
- An independently materialized real `voiceDiagnosisPayload()` matrix still
  projected all six current cases:

  ```text
  anti_gaming              session+turn
  storage_fault            session+turn+server_audio_write
  tts_fault                session+turn+server_audio_write
  reasoning_fault          session+turn
  metadata_no_speech       session+turn
  metadata_context_failure session+turn
  ```

  Projection emits only session, turn, optional server-audio-write, and optional
  release evidence. Archive evidence remains `deterministic_derived`; no
  provider stage is fabricated.
- The real attribution progression remains `endpoint_unknown` ->
  `playback_not_observed` -> `endpoint_playout_observed`. Every result keeps
  `human_heard: "unknown"`; endpoint observation is never labeled physical
  hearing.
- Endpoint records cannot assert server source, tenant, release, or calibration
  authority. Trusted authority remains a separate options input. Attribution
  rebuilds records and recomputes forged duration fields.
- Existing tests still reject conflicting IDs, cross-turn/client evidence,
  multiple semantic receipt/playout milestones, playout without receipt,
  numeric coercion/fractions, scalar overflow, cycles, exotic objects,
  accessors, symbols, non-enumerable entries, custom array prototypes,
  inherited/own iterator behavior, holes, and configured/count overflow.
- Normalized records, diagnosis projections, timeline/record arrays, clock
  relation, duration map, and attribution results remain frozen.
- Static inspection found no import/require, filesystem/database/network access,
  environment read, timer, exporter, randomness, route, canonical-store
  mutation, OpenTelemetry mapping, or public-standard claim in the module.

## Verification evidence

- `node --check lib/voice-reliability-timeline.js`: pass.
- `node --check test/voice-reliability-timeline.test.js`: pass.
- `node --test test/voice-reliability-timeline.test.js`: **29 pass, 0 fail**.
- `node --test --experimental-test-coverage
  test/voice-reliability-timeline.test.js`: timeline module **99.62% lines,
  95.21% branches, 100% functions**; uncovered source lines are the two
  documented guards at `339-340` and `946-947`.
- Fresh serial full gateway gate,
  `MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"`:
  **291 pass, 0 fail, 1 intentional skip** in **68.3 s**.
- `git diff --check`: pass.
- No-index whitespace checks over the 14 pre-existing untracked owned files:
  pass. This report is checked separately after writing.

## Required next-integration boundary

After these blockers pass another fresh audit, the browser route must still
accept only JSON-decoded, bounded `endpoint_records`; it must not expose
`server_records`, `diagnosis`, origin selection, or trusted authority. The
write-only ticket must bind tenant/project, allowed origin, session/turn,
observer, schema, nonce, expiry, revocation, and replay/idempotency state.
Recorder failure must remain outside the canonical voice outcome. This pure
candidate still does not claim routing, persistence, endpoint emission, a
rendered UI, cohort percentiles, replay, CI optimization, improvement agents,
or the durable operations brief.

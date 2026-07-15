# Repair result: timeline final-audit-3 blockers

## Verdict

**PASS — all four audit-3 blockers are repaired and the lane is ready for a
different independent final auditor.**

No route, store, browser, Android, active tree, commit, merge, preview, or
deployment surface was touched. The candidate remains a pure, derived Moa-only
timeline projection.

## Repairs completed

### 1. Composed content and audio names now fail closed

The recursive scanner now canonicalizes camel, snake, kebab, whitespace,
punctuation, and case before applying one segmented policy. `transcript`,
`text`, `prompt`, `content`, `completion`, and `message` are sensitive wherever
they occur in a composed key
(`gateway/lib/voice-reliability-timeline.js:191-217`). Exact typed metadata
exceptions are enumerated separately at `:218-229`; values such as
`transcript_chars`, `completion_ms`, `message_count`, and `content_type` must
also satisfy their numeric or bounded media-type contract at `:844-859`.

Audio namespace detection now recognizes an `audio` segment anywhere in a
normalized key/path (`:826-842` and `:869-871`). Only exact typed root counters
and the existing nested audio metadata allowlist pass. Unknown containers,
scalar audio, samples, frames, payloads, blobs, and content fail before
projection.

Regressions cover camel, snake, kebab, whitespace, period, and slash variants
of:

```text
userTranscript / user-transcript
assistantText / assistant text
systemPrompt / system.prompt
modelContent / model_content
completionText / completion/text
userMessage / user-message
audioSamples / audio samples
audioContent / audio-content
audioFrames / audio.frames
assistantAudioSamples / assistant_audio_samples
```

The same suite proves valid numeric content/audio counters and bounded MIME
metadata remain accepted, while mistyped or over-limit exceptions fail closed.

### 2. Credential families are consistent across values and IDs

The shared credential detector now includes password/passwd, generic secret,
session token, ID token, webhook secret, and `whsec_*` in addition to the
previous API/access/refresh/client-secret, bearer/JWT, OpenAI/Google,
GitHub/GitLab, Slack, SendGrid, AWS, npm, Stripe-key, and private-key families
(`gateway/lib/voice-reliability-timeline.js:19-36`). Because arbitrary strings
and every opaque identifier use that detector, the policy is consistent across
all exported ingest shapes.

The five audit-3 value/ID probes now reject:

```text
password_abcdefghijklmnop
secret_abcdefghijklmnop
session_token_abcdefghijklmnop
id_token_abcdefghijklmnop
whsec_abcdefghijklmnop
```

Explicit bracketed redactions for every new family remain accepted alongside
the previous `Bearer [redacted]`, `api_key_[redacted]`, Slack, and SendGrid
redactions.

### 3. Oversized arrays reject before bulk descriptor materialization

`assertOrdinaryDataArray` now checks exact standard-array prototype and symbols,
reads the single own `length` descriptor, and applies the 4,096-item bound
before calling `Object.getOwnPropertyDescriptors`
(`gateway/lib/voice-reliability-timeline.js:990-1022`). Only an admitted array
receives the full hole/accessor/non-enumerable/named-entry validation.

A 100,000-item dense-array regression instruments the bulk descriptor call and
proves:

```text
rejected: voice reliability timeline input array exceeds item limit
bulk descriptor calls for hostile dense array: 0
```

The existing custom-prototype, inherited/own iterator/getter, sparse, symbol,
non-enumerable, named-property, cycle, node, and depth regressions remain green
with zero input-executed behavior.

### 4. Byte admission now matches exact JSON encoding

The bounded walker now accounts for exact JSON bytes from already validated own
data (`gateway/lib/voice-reliability-timeline.js:939-988`):

- encoded string values and keys, including escapes and UTF-8;
- exact finite-number, boolean, and null encodings;
- every object/array delimiter, colon, and comma; and
- recursively validated own data only, with cycles and unsupported values
  rejected before acceptance.

Focused fixtures contain 4,000 array entries plus escaped keys/values. A valid
diagnosis at exactly 131,072 bytes and a valid attribution timeline at exactly
524,288 bytes pass. Adding one encoded byte to either fails with the byte-limit
error. The original 131,302-byte and 527,390-byte bypass shapes now reject.

## Preserved correctness, trust, and compatibility

- The isotonic causal-order implementation is unchanged. All six permutations
  of the reversed-wall receipt/playout example remain byte-identical and display
  server write -> endpoint receipt -> endpoint playout.
- Construction remains group sorts plus one total global sort, `O(n log n)` at
  the hard 256-record cap; no pair-dependent comparator, topological rescan, or
  receipt/playout cross product was introduced.
- Exact session, turn, observer, surface, clock, calibration, source, and server
  authority checks remain unchanged. Endpoint input still cannot assert tenant,
  release, server source, or calibration authority.
- The real diagnosis attribution progression remains `endpoint_unknown` ->
  `playback_not_observed` -> `endpoint_playout_observed`, always with
  `human_heard: "unknown"`.
- An independently materialized matrix from the production
  `voiceDiagnosisPayload()` still projects all six current fixtures:

  ```text
  anti_gaming              session+turn
  storage_fault            session+turn+server_audio_write
  tts_fault                session+turn+server_audio_write
  reasoning_fault          session+turn
  metadata_no_speech       session+turn
  metadata_context_failure session+turn
  ```

  Projection still emits only session, turn, optional deterministic-derived
  server-audio-write, and optional server-authority release evidence; it
  fabricates no provider stage.
- Normalized records, projections, timeline/record arrays, clock relation,
  duration map, and attribution outputs remain frozen.
- A focused static regression confirms the production module has no imports,
  filesystem/database/network access, environment reads, timers, exporter,
  randomness, route, or canonical-store mutation.

## Verification evidence

- `node --check lib/voice-reliability-timeline.js`: pass.
- `node --check test/voice-reliability-timeline.test.js`: pass.
- `node --test test/voice-reliability-timeline.test.js`: **32 pass, 0 fail**.
- `node --test --experimental-test-coverage
  test/voice-reliability-timeline.test.js`: timeline module **99.64% lines,
  95.85% branches, 100% functions**. The only uncovered source lines are the
  structurally unreachable closed-record normalized-size guard (`364-365`) and
  invalid own Array length descriptor guard (`1000-1001`). Every reachable
  audit-4 rejection and attribution branch has an executable regression.
- Fresh exact-state serial full gateway gate,
  `MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"`:
  **294 pass, 0 fail, 1 intentional skip** in **69.6 s**.
- Tracked and per-untracked-file whitespace checks: pass after this result.

## Residual integration boundary

This repair adds no authenticated ingestion route, persistence, endpoint
emission, exporter, spool, rendered timeline, cohort query, replay, CI agent,
or operations brief. A later route must JSON-decode plain data and expose only
bounded endpoint records through a short-lived, revocable, write-only ticket
bound to tenant/project, origin, session/turn, observer, schema, nonce, expiry,
and replay/idempotency state. It must never expose diagnosis, server records,
origin selection, or trusted authority to the browser, and recorder failure
must remain outside the canonical voice outcome.

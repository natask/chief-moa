# Final independent audit 2: voice reliability timeline MVP

## Verdict

**BLOCK**

The repaired candidate closes the original comparator-cycle exploit, rejects the
original calibration and duplicate-milestone attacks, and preserves the real
three-state diagnosis proof. It is not ready to commit because its deterministic
record order contradicts admitted same-clock causality and its unified privacy
scanner still admits raw voice/tool material and several common credential
forms.

No implementation, route, store, browser, Android, active tree, commit, merge,
or deployment surface was edited by this audit.

## Blocking findings

### 1. The total order is deterministic but reverses authoritative endpoint causality

`validateEndpointMilestones` correctly treats same-clock monotonic time as the
causal authority and accepts receipt `100` followed by playout `200`
(`gateway/lib/voice-reliability-timeline.js:565-590`). The repaired comparator,
however, sorts raw wall observation time before every clock and monotonic field
(`gateway/lib/voice-reliability-timeline.js:593-606`). Timeline construction
sorts with that comparator before deriving clock relation and duration
(`gateway/lib/voice-reliability-timeline.js:372-376`).

An independent all-permutations probe used:

- endpoint receipt: wall `3000`, monotonic `100`;
- endpoint playout: wall `1000`, monotonic `200`; and
- server write: wall `2000`.

All six permutations now produce one byte-identical order, but that order is:

```text
permutations_unique 1 event:playout,event:write,event:receipt
causal_contradiction true mono 100 200
```

The focused regression currently codifies this reversed order at
`gateway/test/voice-reliability-timeline.test.js:485-508`. A synchronized
timeline must not display playout before the same endpoint/clock's admitted
receipt. This also conflicts with the lane goal that ordering use monotonic time
and the implementation contract's local-monotonic ordering rule
(`goal.md:35-36`, `implementation-contract.md:92-99`).

Replace wall-first sorting with a transitive deterministic construction that
preserves causal edges, for example a canonical topological order or an isotonic
navigation key, and use wall/source/type/event ID only as stable navigation tie
breakers. Add a regression that requires every permutation to be identical *and*
requires receipt to precede playout when their exact endpoint clock establishes
that relation.

### 2. The unified sensitive-data policy still has raw-content and credential gaps

`recordsFromVoiceDiagnosis` accepts an intentionally open real diagnosis shape
and relies on `assertNoSensitiveData` as its privacy boundary
(`gateway/lib/voice-reliability-timeline.js:271-278`). The key vocabulary and
normalized-key rules at `:124-168` and `:688-710` match combined names such as
`audio_payload` and `tool_arguments`, but do not recognize the equivalent nested
paths `audio.payload` or `tool.arguments`; they also omit singular/general forms
such as `key`, `raw_headers`, and AWS secret-access-key variants. The value
patterns at `:19-35`, reused for opaque IDs at `:830-840`, omit common API/access
token prefixes, Slack `xoxc` tokens, SendGrid-shaped tokens, and comparable
credential forms.

Independent probes were accepted:

```text
nested_audio_blob accepted
nested_audio_payload ACCEPTED
nested_tool_arguments ACCEPTED
singular_header_key accepted
plain_key_name accepted
raw_headers_variant ACCEPTED
aws_secret_key ACCEPTED
slack_xoxc ACCEPTED
sendgrid_token ACCEPTED
credential_id_probe api_key_abcdefghijklmnop accepted
credential_id_probe access_token_abcdefghijklmnop accepted
xoxc-123456789012-abcdefghijklmnop ACCEPTED_AS_ID
SG.abcdefghijklmnop.qrstuvwxyz0123456789 ACCEPTED_AS_ID
```

These contradict the metadata-only contract's recursive rejection of audio
payload/body/blob, tool arguments/results, raw headers, keys, and common
credentials. Because diagnosis fields are otherwise open, rejecting unknown
record keys later does not close this path. Opaque IDs also remain a bounded but
real exfiltration channel for the admitted token formats.

The stricter policy need not break current Chief Moa data. An independently
materialized matrix of all six current `voiceDiagnosisPayload()` fixtures passed
projection, including the real redacted reasoning fault:

```text
anti_gaming              accepted session+turn
storage_fault            accepted session+turn+server_audio_write
tts_fault                accepted session+turn+server_audio_write
reasoning_fault          accepted session+turn
metadata_no_speech       accepted session+turn
metadata_context_failure accepted session+turn
```

Extend the single scanner with path-aware audio/tool/header semantics plus
normalized credential-key families and common token-value/ID formats. Preserve
the executable real-diagnosis matrix as a compatibility gate.

## Repaired behavior independently verified

- The comparator at `gateway/lib/voice-reliability-timeline.js:593-606` is now a
  transitive total tuple ending in unique `event_id`; every input permutation
  produced one order. Finding 1 is about that order's causal meaning, not a
  remaining comparator cycle.
- The originally reported authorization, nested `apiKey`, GitHub PAT, bearer,
  and assignment-shaped API-key probes are rejected, while current
  `[redacted]` diagnosis values remain accepted.
- Exact array validation at `gateway/lib/voice-reliability-timeline.js:768-798`
  rejected array subclasses, custom prototypes, inherited iterator values and
  getters, inherited index getters, own iterator getters, holes, symbols,
  non-enumerable entries, and named getter properties. Counters remained exactly
  zero for every hostile behavior. The same result was reproduced through
  diagnosis projection and attribution-time timeline revalidation.
- Calibration is bound to the one exact endpoint observer, surface, and clock
  epoch at `gateway/lib/voice-reliability-timeline.js:525-550`. Exact calibration
  was accepted; orphan, foreign observer, foreign surface, and foreign clock
  records were rejected. Multiple matching samples retain their full envelope.
- Milestone validation performs one linear scan at
  `gateway/lib/voice-reliability-timeline.js:565-590`; duration derivation is one
  constant-time subtraction at `:645-658`. Static inspection found no receipt by
  playout cross product. Distinct second receipt or playout milestones were
  rejected, and the sole pair produced the exact `100 ms` monotonic duration.
- A separately materialized real `voiceDiagnosisPayload()` reported playback
  `emitted`; projection emitted only `session`, `turn`, and
  `server_audio_write`, all `deterministic_derived`. Attribution remained:

  ```text
  server only         endpoint_unknown
  + endpoint receipt playback_not_observed
  + endpoint playout endpoint_playout_observed (15 ms)
  human_heard        unknown
  ```

- Endpoint input could not assert server source, release, tenant, or calibration;
  build-input `authority` was rejected; trusted authority entered only through
  `options.authority`; attribution revalidated record authority and recomputed
  forged duration fields.
- Same-session/turn/observer/clock joins, conflicting duplicate IDs,
  playout-without-receipt, numeric coercion/fractions/non-finite values, unknown
  record fields, accessors, symbols, non-enumerable properties, exotic
  prototypes, cycles, depth, node count, and byte limits failed closed.
- All explicit scalar maxima were accepted and `max + 1` rejected: 64 MiB audio,
  24-hour durations, 366-day monotonic time, canonical wall time, 24-hour clock
  offset, and five-minute measurement/calibration uncertainty. Exactly 256
  bounded records were accepted and 257 rejected.
- Timeline, record array, records, clock relation, durations, diagnosis
  projection, and attribution outputs were frozen.
- Static inspection found no import/require, filesystem/database/network access,
  environment read, timer, exporter, randomness, route, canonical-store
  mutation, OTel mapping, or public-standard claim in the pure module.

## Verification evidence

- `node --check lib/voice-reliability-timeline.js`: pass.
- `node --check test/voice-reliability-timeline.test.js`: pass.
- `node --test test/voice-reliability-timeline.test.js`: **26 pass, 0 fail**.
- `node --test --experimental-test-coverage
  test/voice-reliability-timeline.test.js`: timeline module **99.55% lines,
  94.90% branches, 100% functions**; uncovered source lines are the two
  previously documented defensive guards at `266-267` and `779-780`.
- Serial full gateway gate,
  `MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"`:
  **287 pass, 1 fail, 1 intentional skip** in **72.6 s**. The sole failure was
  the untouched timing-sensitive test
  `work-history-deployment-control.test.js:145` (expected an active-claim
  rejection after a 60 ms lease, but the lease had expired). Its entire file
  passed **6/6** immediately in isolation. This is unrelated to the pure lane,
  but the failed full-run evidence is recorded rather than represented as green.
- `git diff --check`: pass.
- No-index whitespace checks over every untracked owned module, test, and lane
  document: pass after this report.

## Integration boundary retained

The later browser ingestion route must still JSON-decode plain data and expose
only bounded `endpoint_records`. It must never let the request select
`server_records`, `diagnosis`, `origin`, or `options.authority`; tickets must bind
tenant/project, origin, session/turn, schema, observer, nonce, expiry, and replay
state. Export failure must remain outside the realtime voice outcome. This audit
does not claim persistence, routing, queue/spool behavior, endpoint emission, a
rendered UI, cohort percentiles, replay, CI optimization, or an operations brief.

# Final independent audit: voice reliability timeline MVP

## Verdict

**BLOCK**

The pure candidate proves the intended happy-path diagnosis change, preserves
honest `deterministic_derived` provenance, keeps human hearing unknown, freezes
its accepted outputs, and passes its focused and serial project gates. It is
not ready to commit because five adversarial contract violations remain.

## Blocking findings

### 1. Record ordering is not a deterministic total order

`buildVoiceReliabilityTimeline` sorts with `compareEvidenceRecords`
(`gateway/lib/voice-reliability-timeline.js:332` and `:527-540`). The comparator
uses monotonic time for a same-client pair but wall time for either record when
compared with a server event. Those pairwise rules can form a cycle.

An independent probe used the same three records in different input
permutations:

- client receipt: wall `3000`, monotonic `100`;
- client playout: wall `1000`, monotonic `200`; and
- server write: wall `2000`.

The candidate returned two orders for the identical evidence set:

```text
event:write,event:receipt,event:playout
event:playout,event:write,event:receipt
```

This violates deterministic ordering and can present playout before its receipt.
Use one transitive total-order construction (or a deterministic topological
order with a canonical tie break), then add an all-permutations regression.

### 2. Credential-bearing diagnosis input and opaque IDs pass the privacy gate

`recordsFromVoiceDiagnosis` calls the diagnosis-only scanner at
`gateway/lib/voice-reliability-timeline.js:237-240`. That scanner's key list at
`:591-607` omits credential families such as `authorization`, `api_key`,
`access_token`, `client_secret`, and cookies. The stronger record-key list at
`:106-138` is not applied to diagnosis input. Separately, the value pattern at
`:18-19`, used by `exactId` at `:724-734`, recognizes only a few token formats.

Independent probes showed both calls were accepted:

```text
recordsFromVoiceDiagnosis({ ..., authorization: "Bearer ...",
  nested: { api_key: "ghp_..." } })
normalizeVoiceEvidenceRecord({ ..., event_id: "ghp_..." })
```

This contradicts the metadata-only/credential-rejection contract and leaves
opaque ID fields usable as a small exfiltration channel. Apply one recursive,
normalized sensitive-key policy to every exported ingest shape and extend the
bounded secret-value detector without weakening canonical real diagnosis
compatibility.

### 3. Array prototype code executes during supposedly pure validation

The array walker at `gateway/lib/voice-reliability-timeline.js:666-680` checks
only own symbol keys and own descriptors. It neither validates the array
prototype nor iterates own numeric descriptors directly; `for (const item of
value)` invokes an inherited `Symbol.iterator`.

An independent probe placed a side-effecting iterator on a custom prototype of
`endpoint_records`. `buildVoiceReliabilityTimeline` executed it and printed:

```text
inherited_iterator_executed true
```

That fails the prototype/accessor and pure-work requirements. Reject nonstandard
array prototypes before traversal and avoid attacker-dispatchable iteration
during validation. Add array-subclass, inherited iterator/getter, sparse,
symbol, and non-enumerable regressions.

### 4. A calibration for a different endpoint is retained in the timeline

`assertSingleEndpointObserver` only inspects `client_observed` records
(`gateway/lib/voice-reliability-timeline.js:481-490`). A server-owned
`clock_calibration` bound to another observer, surface, and clock therefore
survives normalization. `deriveClockRelation` merely ignores it when selecting
matching samples (`:549-564`), leaving unrelated evidence in a supposedly
single-observer timeline.

The independent probe combined a browser receipt for `observer:a/clock:a` with
an Android calibration for `observer:foreign/clock:foreign`; the foreign record
was accepted and retained while the relation became `uncertain`.

Reject calibration records that do not bind exactly to the timeline's one
endpoint observer/surface/clock epoch (or reject calibration when no matching
endpoint clock exists). Do not silently retain stale cross-endpoint evidence.

### 5. Receipt/playout correlation cherry-picks an uncorrelated minimum and is quadratic

`deriveMonotonicDurations` performs the full receipt-by-playout cross product
and selects its minimum (`gateway/lib/voice-reliability-timeline.js:572-588`).
There is no event/segment correlation and no uniqueness rule for these
milestones. With receipts at monotonic `100` and `190` and the first playout at
`200`, the output was:

```text
{ endpoint_receipt_to_playout_ms: 10 }
```

The result pairs the later receipt with the playout instead of reporting the
first receipt-to-first playout interval (`100 ms`) or declaring correlation
ambiguous. It is also `O(receipts * playouts)`, contrary to the explicit linear
resource contract. Define one non-gameable milestone/correlation rule, enforce
it in causality validation, and derive it in one linear pass.

## Verified behavior that should be preserved

- A real `voiceDiagnosisPayload()` fixture reported gateway playback
  `emitted`; the derived results changed as follows:

  ```text
  server only       -> endpoint_unknown
  + endpoint receipt -> playback_not_observed
  + endpoint playout -> endpoint_playout_observed
  ```

  Every state kept `human_heard: "unknown"`; the playout summary explicitly
  says human perception is not measured.
- Diagnosis projection emits only `session`, `turn`, `server_audio_write`, and
  optional `release` records. Archive-derived milestones are
  `deterministic_derived`; no STT/reasoning/TTS provider stage is fabricated.
- Endpoint records cannot choose a server source, calibration, tenant, or
  release through the endpoint record shape. `buildVoiceReliabilityTimeline`
  rejects `authority` in its input; trusted authority enters through the
  separate `options.authority` boundary.
- Exact session/turn mismatch, conflicting duplicate IDs, cross-client endpoint
  observations, impossible playout-without-receipt, numeric coercion,
  fractional values, cycles, own symbols, ordinary object accessors, exotic
  object prototypes, depth, node, bytes, and count overflow fail closed.
- Exactly 256 minimal records were accepted and 257 were rejected. Audio,
  duration, monotonic, wall-clock, calibration-offset, and uncertainty bounds
  are explicit safe-integer checks.
- Timeline, record array, individual records, durations, clock relation,
  diagnosis projection array, and attribution result were all independently
  confirmed frozen.
- Static inspection found no imports, filesystem/database/network access,
  environment reads, timers, exporters, randomness, or canonical-store/route
  mutation in the new module. This remains a Moa-only draft, not an OTel or
  public-standard claim.
- Multiple matching calibration samples use the full lower/upper envelope
  rather than selecting one flattering sample; uncalibrated cross-source time
  remains `uncertain`; no cross-source monotonic duration is fabricated.

## Verification evidence

- `node --check lib/voice-reliability-timeline.js`: pass.
- `node --check test/voice-reliability-timeline.test.js`: pass.
- `node --test test/voice-reliability-timeline.test.js`: **19 pass, 0 fail**.
- `MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"`:
  **281 pass, 0 fail, 1 intentional skip** in `70.4 s`.
- `node --test --experimental-test-coverage
  test/voice-reliability-timeline.test.js`: focused module **95.80% lines,
  90.60% branches, 100% functions**. This does not meet the contract's stated
  branch-oriented rejection coverage; the missing adversarial cases above must
  become regressions.
- `git diff --check`: pass.
- No-index whitespace checks for the untracked module, test, and every lane
  Markdown file: pass.
- Worktree status after audit contains only the pre-existing untracked lane
  module/test/docs plus this audit; implementation was not edited.

## Required next-integration boundary

After the blockers pass a fresh audit, browser ingestion must JSON-decode into
plain own-data arrays/objects and expose only a bounded endpoint-record shape.
The request must never control `server_records`, `diagnosis`, `origin`, or
`options.authority`. The gateway must bind the short-lived write-only ticket to
tenant/project, allowed origin, session/turn, schema, endpoint observer, nonce,
and replay/idempotency state; it must assign server authority itself. Endpoint
export failure must remain off the realtime voice outcome path. Persistence,
route integration, queue/spool behavior, and the operations brief remain later
contracts and are not claimed by this pure candidate.

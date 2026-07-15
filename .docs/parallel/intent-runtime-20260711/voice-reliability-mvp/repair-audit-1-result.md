# Repair result: voice timeline final-audit blockers

## Verdict

**PASS — ready for a different independent final auditor.**

All five `final-audit.md` blockers are closed in the isolated timeline lane.
No route, store, browser, Android, active-tree, commit, merge, or deployment
surface was touched.

## Repairs completed

1. **Transitive ordering.** Records now use one global wall-observation
   navigation tuple followed by canonical source, observer, surface, clock,
   optional monotonic, type, and event-ID tie-breakers. The same cyclic
   three-record evidence produces one byte-identical order across all six input
   permutations.
2. **Unified sensitive-data policy.** Every exported ingest shape, including
   record input/options, diagnosis/options, timeline input/options,
   attribution-time timeline revalidation, arrays, authority, and opaque IDs,
   receives the same recursive normalized-key and credential-value checks.
   Authorization/cookies/headers, API/access/refresh tokens, client/private
   secrets, passwords, common bearer/JWT/OpenAI/Google/GitHub/GitLab/Slack/AWS/
   npm/Stripe/private-key forms, and camel/kebab/snake variants fail closed.
   The real redacted gateway diagnosis remains accepted.
3. **Iterator-free exact arrays.** Validation requires the exact standard
   `Array.prototype`, own indexed enumerable data entries, no holes, named
   properties, own symbols, accessors, non-enumerable entries, subclasses, or
   custom prototypes. Traversal and record normalization read captured own
   descriptors by numeric index; they never invoke an input iterator or map
   method. All inherited/own iterator/getter probes reported zero side effects.
4. **Exact calibration binding.** Every calibration now requires one matching
   endpoint observer, surface, and clock epoch in the same timeline. Orphan,
   clockless-orphan, foreign-observer, foreign-surface, and foreign-clock
   calibration records are rejected instead of retained and ignored.
5. **Unambiguous linear milestones.** The MVP admits at most one semantic first
   endpoint receipt and one first endpoint-observed playout after idempotent
   event-ID collapse. It performs one linear milestone scan, one causal check,
   and one constant-time same-clock monotonic subtraction. Distinct duplicate
   milestones fail; the former minimum-pair cross product no longer exists.

## Independent repair probes

The original audit probes now report:

```text
unique_sort_orders [ 'event:playout,event:write,event:receipt' ]
diagnosis_credentials rejected
credential_id rejected
hostile_array rejected
inherited_iterator_executed false
foreign_calibration rejected
multiple_receipts rejected
```

An independently materialized real `voiceDiagnosisPayload()` still reports
gateway playback `emitted` and produces:

```text
server only        -> endpoint_unknown
+ endpoint receipt -> playback_not_observed
+ endpoint playout -> endpoint_playout_observed (15 ms monotonic proxy)
```

Every attribution keeps `human_heard: "unknown"`; the endpoint-playout state
says human perception is not measured. Projection still emits only session,
turn, deterministic-derived server-audio-write, and optional server-authority
release records, so it fabricates no provider stage.

## Verification evidence

- `node --check lib/voice-reliability-timeline.js`: pass.
- `node --check test/voice-reliability-timeline.test.js`: pass.
- `node --test test/voice-reliability-timeline.test.js`: **26 pass, 0 fail**.
- `node --test --experimental-test-coverage
  test/voice-reliability-timeline.test.js`: **99.55% lines, 94.90% branches,
  100% functions**. The only uncovered source lines are two unreachable
  defensive guards: normalized output exceeding 4 KiB after the much tighter
  closed scalar/ID shape, and a malformed own Array `length` descriptor that
  JavaScript array invariants do not permit without executing Proxy traps.
  Every repair-contract rejection and attribution branch has an executable
  regression.
- Final exact-state serial project gate,
  `MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"`:
  **288 pass, 0 fail, 1 intentional skip** in **67.9 s**.
- Exactly 256 bounded transport records remain accepted; 257 total records,
  per-array overflow, configured-limit overflow, scalar overflow, node/depth/
  byte overflow, cycles, symbols, accessors, exotic prototypes, and coercion
  remain rejected.
- Timeline, record array, individual records, clock relation, durations,
  projection array, and attribution outputs are explicitly regression-checked
  frozen.
- Static scan of the module finds no imports, filesystem/database/network
  access, environment reads, timers, exporter, randomness, or canonical-state
  mutation.
- `git diff --check` and no-index whitespace checks over every untracked owned
  module/test/lane-document file: pass after the final test state.

## Residual integration boundary

No new blocker was found in the pure module. The later authenticated ingestion
slice must still JSON-decode plain data and ensure the request can populate only
`endpoint_records`; it must never expose `server_records`, `diagnosis`,
`origin`, or `options.authority` to the browser. Ticket scope, replay/idempotency,
origin/session/observer binding, nonblocking export, persistence, and the
operations brief remain later contracts and are not claimed here.

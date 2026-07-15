# Repair result: timeline final-audit-2 blockers

## Verdict

**PASS — both blockers are repaired and the lane is ready for a different
independent final auditor.**

No route, store, browser, Android, active tree, commit, merge, or deployment
surface was touched. The implementation remains a pure Moa-only projection.

## Repairs completed

### 1. Deterministic isotonic navigation preserves causal chains

`orderEvidenceRecords` now precomputes one navigation key rather than switching
comparison rules per pair (`gateway/lib/voice-reliability-timeline.js:666-695`).
It groups monotonic records by exact source, observer, surface, and clock epoch;
sorts each group by monotonic time plus canonical semantic/event ties; and assigns
the group's running maximum observed wall time. One global total tuple then sorts
the precomputed navigation time, exact clock domain, monotonic value, type, and
unique event ID (`:697-720`).

The work is `O(n log n)` and bounded by 256 records. The nested group/member loop
is linear in total group membership; each record belongs to exactly one group.
There is no pair-dependent exception, topological rescan, receipt/playout cross
product, or quadratic join.

The original six-permutation probe now reports:

```text
isotonic_permutations 1 event:write,event:receipt,event:playout
```

The focused suite also proves a three-event endpoint chain remains receipt ->
transport -> playout when its wall times move `3000 -> 500 -> 1000`, and proves
receipt precedes playout when both share the exact same monotonic millisecond but
their wall times are reversed. The semantic tie does not rely on timestamp
resolution distinguishing the two milestones.

### 2. One deep privacy policy closes the remaining content and credential paths

The same scanner still runs on every exported ingest shape. It now combines:

- canonical camelCase, kebab, snake, whitespace, period, and punctuation key
  normalization;
- exact and segmented sensitive key families at
  `gateway/lib/voice-reliability-timeline.js:125-210`;
- bounded, path-aware audio containers and scalar metadata at `:211-240` and
  `:801-837`, rejecting raw audio scalars/arrays, data URIs, unknown containers,
  payload/blob/body/data variants, and oversized metadata references;
- tool arguments/results/calls, raw/header/body/data/payload/blob/key variants,
  authorization/cookie and credential/secret/token/password families; and
- value/opaque-ID signatures at `:19-36` for API/access/refresh/client-secret
  prefixes, all Slack `xox*` families including `xoxc`/`xoxd`, SendGrid `SG.*`,
  GitHub/GitLab, npm, Stripe, bearer/basic/JWT, OpenAI/Google, AWS key IDs, and
  private-key material.

The prior accepted probes now fail:

```text
nested_audio_blob rejected
nested_audio_payload rejected
nested_tool_arguments rejected
raw_headers rejected
plain_key rejected
aws_secret rejected
slack rejected
sendgrid rejected
api_key_* ID rejected
access_token_* ID rejected
refresh_token_* ID rejected
client_secret_* ID rejected
xoxc/xoxd ID rejected
SG.* ID rejected
```

The hostile custom-array probe still reported `hostile_input_calls 0`. Existing
array subclass, inherited/own iterator/getter, inherited index getter, sparse,
symbol, non-enumerable, and named-property regressions remain green.

The policy retains canonical redaction. `Bearer [redacted]`,
`api_key_[redacted]`, `xoxc-[redacted]`, and `SG.[redacted].[redacted]` remain
accepted as already-redacted values. An independently materialized matrix of all
six current real `voiceDiagnosisPayload()` variants still projects:

```text
anti_gaming              session+turn
storage_fault            session+turn+server_audio_write
tts_fault                session+turn+server_audio_write
reasoning_fault          session+turn
metadata_no_speech       session+turn
metadata_context_failure session+turn
```

No raw diagnosis field is copied into the normalized records. The current
projection still emits only session, turn, deterministic-derived server audio,
and optional server-authority release evidence.

## Preserved trust, resource, and attribution behavior

- Exact session/turn/observer/clock joins, calibration identity, duplicate-ID
  conflict detection, one receipt/one playout semantics, and monotonic-only
  duration subtraction remain unchanged.
- The real diagnosis progression remains `endpoint_unknown` ->
  `playback_not_observed` -> `endpoint_playout_observed`; every state keeps
  `human_heard: "unknown"`.
- Endpoint inputs still cannot assert server sources, tenant, release, or
  calibration authority. Trusted authority still enters only through the
  separate options boundary and attribution rebuilds/revalidates all records.
- Exactly 256 bounded records remain accepted and 257 rejected. Record/input,
  scalar, byte, node, depth, clock, duration, audio, and configured-limit tests
  remain green.
- Normalized records, timelines, record arrays, clock relations, durations,
  projections, and attributions remain frozen.
- Static inspection found no import/require, filesystem/database/network access,
  environment read, timer, exporter, randomness, canonical-store mutation,
  route, OTel mapping, or public-standard claim.

## Verification evidence

- `node --check lib/voice-reliability-timeline.js`: pass.
- `node --check test/voice-reliability-timeline.test.js`: pass.
- `node --test test/voice-reliability-timeline.test.js`: **29 pass, 0 fail**.
- `node --test --experimental-test-coverage
  test/voice-reliability-timeline.test.js`: timeline module **99.62% lines,
  95.21% branches, 100% functions**. The only uncovered source lines are the two
  structurally unreachable defensive guards: normalized closed-shape output
  exceeding 4 KiB (`339-340`) and an invalid own Array length data descriptor
  that JavaScript array invariants cannot construct without Proxy traps
  (`946-947`). Every reachable rejection and attribution rule has executable
  coverage.
- Final exact-state serial gateway gate,
  `MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"`:
  **291 pass, 0 fail, 1 intentional skip** in **67.3 s**.
- `git diff --check`: pass.
- No-index whitespace checks over every untracked owned module, test, and lane
  document: pass after this result.

## Residual integration boundary

This pure candidate still adds no authenticated ingestion route, persistence,
queue/spool/exporter, endpoint emission, or rendered timeline. Later integration
must expose only bounded endpoint records through a short-lived, origin/session/
turn/observer/schema/nonce-bound write ticket; it must not expose diagnosis,
server records, origin selection, or trusted authority to the client. Export
failure must stay outside the realtime voice outcome. Cohort percentiles, replay,
CI optimization, improvement agents, and the durable operations brief remain
separate gated milestones.

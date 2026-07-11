# MT foundation implementation contract

## Objective and non-negotiables

Implement a versioned semantic envelope, allowlist-first privacy boundary,
metric-cardinality boundary, and bounded asynchronous exporter. Export failure
must not affect product behavior. No raw content, identity, tokens, secrets, or
financial fields. No vendor SDK or production rollout.

## Owned paths

- `gateway/lib/semantic-telemetry.js`
- `gateway/test/semantic-telemetry.test.js`
- `reference/openspec/changes/telemetry-observability-foundation/`
- `scratch/agent-loop/runs/20260710-moa-portfolio-program/mt-telemetry/`
- `ARCHITECTURE.md` telemetry boundary only

Do not touch server routes, active deployment configuration, Android, browser
extension, canonical event storage, auth, or database schema.

## Required behavior and edges

- Closed surface, event-name, and attribute-key vocabularies.
- Release version/build and opaque trace/parent/canary correlation.
- Correlation absent from metric dimensions.
- Scalar/length/count bounds enforced without recursive payload traversal.
- Token-shaped values rejected.
- Fixed queue/batch bounds; exporter starts after the caller returns.
- Invalid, overflowed, slow, and failed export paths stay failure-isolated and
  observable through bounded counters.

## Forbidden shortcuts

Regex-only recursive scrubbing; arbitrary payload export; sync exporter I/O;
unbounded retry; identity IDs as labels; mocks presented as backend ingestion;
vendor-superiority claims; benchmark claims from architecture review.

## Quality and resource targets

New decision functions target cyclomatic complexity <=10 and CRAP <=15. Queue,
batch, key count, string length, and identifier lengths are constant-bounded.
CPU/RSS/network targets remain unmeasured until isolated preview.

## Acceptance commands

```sh
cd gateway
node --test test/semantic-telemetry.test.js
npm run check
cd ..
npx --yes @fission-ai/openspec validate telemetry-observability-foundation --strict
```

Block on sensitive leakage, high-cardinality metric labels, synchronous export,
unbounded memory/retry, or misleading measured claims. Escalate consent,
residency, region, and paid preview decisions to Tier 0 after MF integrates.

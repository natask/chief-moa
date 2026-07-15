# Repair contract: voice timeline final-audit blockers

## Required fixes

1. Replace the pair-dependent comparator with one transitive total order. Wall
   observation time is the global navigation key; source/observer/clock,
   monotonic time, type, and event ID are canonical tie-breakers only. Monotonic
   time remains the duration authority, not a cross-record sorting exception.
   Every permutation of one evidence set must yield byte-identical order.
2. Apply one recursive sensitive-key and token-value policy to every exported
   ingest shape, including diagnosis input, records, timelines, arrays, and
   opaque IDs. Reject authorization/cookie/header, api/access/refresh tokens,
   client secrets/passwords, GitHub/GitLab/Slack/AWS/common bearer formats, and
   normalized key variants without rejecting the real redacted diagnosis.
3. Validate arrays as exact ordinary own-data arrays before traversal: standard
   `Array.prototype`, no own symbols/accessors/non-enumerables/named props,
   holes, subclass/custom prototype, or inherited executable iterator/getter.
   Traverse indexed own descriptors directly; never dispatch an input-owned or
   inherited iterator/map method.
4. Bind every clock calibration exactly to the single admitted endpoint
   observer, surface, and clock epoch. Reject foreign/stale calibration and
   calibration with no matching endpoint clock; never merely ignore and retain
   it.
5. Make receipt/playout milestones unambiguous and linear. For this MVP admit at
   most one first endpoint receipt and one first endpoint-observed playout per
   timeline/observer/turn. Reject duplicate milestone records even with distinct
   event IDs. Validate causal order once and compute the one same-clock
   monotonic duration in O(n); no cross product or minimum-pair selection.

## Required adversarial regressions

- all six permutations of the cyclic three-record example produce one order;
- diagnosis nested/top credential keys and token values plus credential-shaped
  event/session/turn/observer/clock IDs fail, while the actual redacted gateway
  diagnosis remains accepted;
- array subclass/custom prototype/inherited iterator/getter/own iterator/sparse/
  symbol/non-enumerable/named-property probes cause zero side effects;
- foreign observer/surface/clock calibration and orphan calibration fail;
- multiple receipts or playouts fail as ambiguous, and one receipt+one playout
  yields the exact first-milestone duration in a single linear pass;
- preserve the real three-state diagnosis proof, frozen outputs, provenance,
  authority separation, all scalar/resource limits, and no I/O/timer/env.

## Ownership and constraints

Own only the existing timeline module/test and this lane's notes. Do not touch
routes, canonical stores, browser, Android, active tree, or live services. Do
not commit, merge, or deploy.

## Verification

```sh
cd gateway
node --check lib/voice-reliability-timeline.js
node --check test/voice-reliability-timeline.test.js
node --test test/voice-reliability-timeline.test.js
node --test --experimental-test-coverage test/voice-reliability-timeline.test.js
MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"
git diff --check
```

Write `repair-audit-1-result.md` with exact evidence and coverage. Root will
assign a different final auditor before commit.

# Next contract: grounded operations brief

This is the smallest implementation after endpoint evidence is integrated. It
answers the user's “thousand cuts” problem without turning a language model into
the source of truth.

## Outcome

Create one durable, queryable daily brief that says:

- what failed for the first time;
- what recurred or worsened;
- which active intents, releases, deployments, and CI runs are affected;
- what evidence is missing or clock-uncertain;
- the single best next investigation or repair intent.

Delivery (notification channel and morning schedule) is a projection. The brief
record exists independently so a missed notification does not lose knowledge.

## Input authorities

- canonical intent rehydration and active priorities;
- canonical voice transaction IDs plus bounded diagnosis/timeline evidence;
- product events and exact action/run/receipt refs;
- server-owned release/deployment/commit refs;
- sanitized CI result artifacts with offered/completed/failed/skipped counts.

Raw audio, transcripts, prompts, model/tool payloads, screen/page content,
credentials, and arbitrary log text never become agent instructions or metric
dimensions. The first implementation consumes metadata-only evidence.

## Deterministic layer before the agent

1. Validate source authority and a fixed time window.
2. Derive a stable failure signature from versioned category, boundary, error
   class, runtime/provider family, and release—not user/session IDs.
3. Group exact occurrences and retain every failed/timed-out/dropped/censored
   denominator.
4. Compare the current window with a fixed lookback and label `new`,
   `recurring`, `worsening`, `improving`, or `insufficient_evidence`.
5. Rank by a versioned policy over severity, recurrence, affected active-intent
   priority, recency, and confidence. Sparse samples cannot outrank a stable
   cohort solely because of a dramatic percentage.

The model may summarize these fixed facts and propose a next intent. It cannot
change grouping, labels, denominators, severity policy, source authority, or
release/CI truth.

## Durable brief shape

- `brief_id`, schema/policy version, generated time, exact window/lookback;
- input snapshot hashes/cursors and dropped/rejected counts;
- at most 20 findings, each with signature, status, occurrence/sample counts,
  severity/confidence, first/last seen, affected release/deploy/intent refs,
  evidence refs/gaps, and code-correlation basis;
- code correlation labeled `direct` only for an exact release/commit/ref;
  temporal/change-set association is explicitly `inferred`;
- one proposed next intent with rationale and acceptance evidence;
- prior brief/finding refs and later repair/outcome refs.

All arrays, strings, queries, source reads, and response bytes are bounded. The
record is append-only/versioned; regeneration creates a new version rather than
rewriting yesterday's conclusion.

## Trust and no-gaming tests

- injected transcript/log instructions do not enter the model prompt;
- dropping hard calls or relabeling timeouts cannot improve the brief;
- a release with fewer completed calls but more rejects is not called improved;
- sparse cohorts report insufficiency, not p99/regression certainty;
- a model cannot invent a commit, intent, failure, confidence, or evidence ref;
- unchanged recurring cuts remain visible until linked to a verified repair or
  an explicit human disposition;
- notification failure does not alter or delete the durable brief.

The first agent is read-only. It may capture a proposed repair as a new intent;
it receives no merge, deployment, production-write, telemetry-policy, or source-
deletion authority.

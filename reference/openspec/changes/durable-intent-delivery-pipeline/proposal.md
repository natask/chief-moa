# Durable Intent Delivery Pipeline

## Why

Chief Moa stores user turns, intents, tasks, runs, evidence, and release facts,
but those records can describe one request without sharing a canonical identity.
A finished harness run can therefore look like a finished user outcome, while
the original intent, acceptance contract, candidate, QA, preview, and promotion
remain disconnected.

## User Outcome

One delivery view answers:

- what the user said and what it currently means;
- which approved contract and ticket define success;
- which exact candidate implemented it;
- which verification and user QA apply to those bytes;
- where the user can test it;
- whether it was promoted and smoked; and
- what is blocked or stale.

## First Slice

Link one explicit current-turn work request to the existing intent runtime and
work-history store. Create one durable intent, one task, and optionally one inert
queued run proposal. Store the intent revision and acceptance-contract reference
on the task and run. Expose a delivery projection.

## Non-Goals

- No historical intent mining or inferred authority from old messages.
- No worker claim, harness execution, code edit, deployment request, or promotion.
- No migration or deletion of legacy task, work-graph, run, or artifact data.
- No claim that a queued or terminal run completes the user outcome.
- No UI, rolling video capture, or gesture change in this gateway slice.

## Success Criteria

- Retrying one source turn produces the same intent, task, and run IDs.
- Task and run projections carry the intent ID, intent revision, and acceptance
  contract reference.
- The delivery projection traces the source, contract, task, and run.
- The queued proposal remains inert until the existing worker claim boundary.
- No deployment or promotion fact is inferred.

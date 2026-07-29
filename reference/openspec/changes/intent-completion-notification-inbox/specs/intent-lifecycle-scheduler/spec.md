# Intent Lifecycle Scheduler

## Context

`gateway/lib/intent-runtime.js` already owns the durable lifecycle:
`captured -> clarified -> planned -> active -> {waiting, blocked} ->
{completed, abandoned, superseded}` (terminal: `completed`, `abandoned`,
`superseded`; see `intent-runtime-router.js:77-99`). An intent claimed by an
agent carries `current_run_id` and `run_lease_expires_at`.
`intentRuntime.neglected({ project_id, before_ms, limit })` already computes
the set of `active` intents with no current run or an expired lease
(`intent-runtime.js:753-765`), exposed read-only at
`GET /v1/intent-runtime/neglected`.

This spec covers what is missing: turning that read-only projection into the
active "keep making forward progress" loop the user asked for, without adding
a second lifecycle or a second event log.

## ADDED Requirements

### Requirement: A scheduler actively drives neglected intents forward

The gateway SHALL run a periodic tick that calls the existing
`intentRuntime.neglected()` projection and, for each returned intent, issues
one bounded re-drive attempt through the existing launch path (broker
relaunch or agent-switchboard wake) rather than a new execution mechanism.

#### Scenario: an active intent's run lease expires with no successor

- GIVEN an intent in lifecycle state `active` whose `run_lease_expires_at` has
  passed and which has recorded no new `intent.run_claimed` event since
- WHEN the scheduler tick runs
- THEN the intent appears in that tick's `neglected()` result
- AND the scheduler issues exactly one re-drive attempt for that intent,
  recorded as a durable `intent.progress_recorded` (or equivalent) event
  naming the tick as actor, so the attempt is itself auditable evidence, not a
  side effect invisible to the user.

#### Scenario: an intent is claimed and healthy

- GIVEN an intent with a current run and an unexpired lease
- WHEN the scheduler tick runs
- THEN that intent is excluded from `neglected()` and receives no re-drive
  attempt.

### Requirement: Re-drive attempts back off and eventually stop

The gateway SHALL bound how many times a single stalled intent is re-driven
before it stops being retried automatically, using a growing wait between
attempts so a transient stall does not become tight-loop churn against the
same launcher.

#### Scenario: repeated stalls on the same intent

- GIVEN an intent has already received re-drive attempts at increasing
  intervals (for example 5m, 15m, 60m) and none produced a new successful
  claim before its lease expired again
- WHEN the attempt count reaches the configured maximum
- THEN the scheduler stops issuing further automatic re-drive attempts for
  that intent
- AND transitions it toward `blocked` (an existing lifecycle state reachable
  from `active`) with a `next_step` naming that automatic retry was
  exhausted, rather than silently continuing to retry forever or silently
  giving up with no trace.

### Requirement: A stalled-out intent produces a notification, not silence

The gateway SHALL post one notification-inbox entry (see
`notification-inbox` capability) when a scheduler gives up on an intent, so
the user learns about the stall the same way they learn about completion.

#### Scenario: automatic retry is exhausted

- GIVEN a scheduler tick just transitioned an intent to `blocked` after
  exhausting its re-drive budget
- WHEN that transition is recorded
- THEN exactly one notification-inbox entry is created for that intent, kind
  `intent_stalled`, non-silent (this is a case the user should actually see,
  unlike a routine completion).

## Non-Goals

- This spec does not implement the scheduler process (cron/interval/worker) in
  this change. It specifies the wake condition, the re-drive action, the
  backoff/give-up contract, and the notification obligation precisely enough
  that implementation is a single well-scoped follow-up against the existing
  `neglected()` projection and `intent-plane` notification store — not a new
  design decision.
- This spec does not change what counts as "active" launch authority; a
  re-drive attempt still goes through the existing broker/switchboard launch
  path and existing capability/tool authorization, never a new execution
  route.

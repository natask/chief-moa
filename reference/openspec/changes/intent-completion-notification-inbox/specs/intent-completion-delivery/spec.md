# Intent Completion Delivery

## Context

`gateway/lib/broker-completion-spine.js` already links a terminal `agent_run`
back to its intent and work-history run, records progress, and calls
`intentRuntime.notify()` to create a durable, intent-scoped
`intent.notification_created` event
(`broker-completion-spine.js:118-141`). As of this change it also posts a
best-effort entry into the shared notification inbox (see
`notification-inbox` capability below).

Neither of those decides *when or how* the user is told. That decision
belongs to the delivery arbiter being built on `feat/voice-spine-20260729`
(modes `overlay` / `interject` / `defer`; a background completion must never
take the floor from an in-flight reply or the user speaking). This spec
defines intent completion's role as a **producer** into that arbiter, not a
second delivery path.

## ADDED Requirements

### Requirement: Intent completion never speaks over an in-flight reply

An intent-completion announcement (voice, overlay, or otherwise) MUST NOT
interrupt an in-flight assistant reply or an in-progress user utterance. It
MUST reach the user only through the delivery arbiter's non-interrupting
modes, never by a code path that bypasses the arbiter.

#### Scenario: an intent finishes while the assistant is mid-reply

- GIVEN the user is receiving an in-flight spoken or text reply
- WHEN a linked intent's agent run reaches a terminal state
- THEN the completion notification is submitted to the delivery arbiter and
  queued
- AND the in-flight reply completes uninterrupted
- AND the completion is delivered afterward (or silently logged to the inbox,
  per the arbiter's own mode selection), never by preempting the reply.

#### Scenario: an intent finishes while the user is speaking

- GIVEN the user is actively speaking (voice capture in progress)
- WHEN a linked intent's agent run reaches a terminal state
- THEN the completion notification is submitted to the delivery arbiter and
  is not spoken, shown, or sounded while capture is active.

### Requirement: Intent completion submits a bounded delivery proposal

The producer (broker completion spine or its notification-inbox write) SHALL
submit one delivery proposal per terminal result, carrying: the notification
id, intent id, a short summary, `kind` (`agent_output_ready` /
`agent_run_stopped` / `intent_stalled`), and a priority tier.

- **Priority tier: `background`.** Every intent-completion delivery this
  change specifies is `background` tier — the routine case (`kind:
  agent_output_ready`) should default to silent/deferred delivery; the
  attention-worthy cases (`agent_run_stopped`, `intent_stalled`) still stay
  `background` tier for interruption purposes (never `interject`-eligible
  against an in-flight reply) but are marked non-silent so they surface
  promptly once a safe gap exists.

#### Scenario: a successful completion is proposed at background priority

- GIVEN an agent run completes successfully and is linked to an intent
- WHEN the completion spine submits its delivery proposal
- THEN the proposal's tier is `background` and its `silent` hint is `true`.

#### Scenario: a failed run is proposed as background but non-silent

- GIVEN an agent run stops with a failure
- WHEN the completion spine submits its delivery proposal
- THEN the proposal's tier remains `background` (it still cannot interrupt an
  in-flight reply) but its `silent` hint is `false`, so the arbiter treats it
  as prompt-but-non-interrupting rather than fully silent.

### Requirement: A missing or unavailable arbiter never blocks completion recording

The gateway SHALL record intent completion (the intent-runtime notification
and the notification-inbox entry) independent of whether the delivery
arbiter is reachable. Delivery is a downstream concern; completion is the
durable fact, and it MUST succeed even when the arbiter does not.

#### Scenario: the arbiter integration is not yet available

- GIVEN the delivery arbiter is not deployed or not reachable
- WHEN an agent run reaches a terminal state
- THEN the intent-runtime notification and the notification-inbox entry are
  still recorded
- AND the completion spine's `complete()` call still returns successfully.

## Requirement Needed From The Arbiter Lane (not built here)

This change's producer contract assumes the arbiter accepts a proposal shaped
like `{ notification_id, intent_id, kind, summary, tier: "background",
silent }` and enforces the no-interrupt guarantee itself. If the arbiter does
not yet expose an ingestion point for background-tier producers outside its
own reply pipeline, that is a gap in `feat/voice-spine-20260729`, not something
this change should route around by building a second delivery mechanism.

## Non-Goals

- This spec does not implement the arbiter or its `overlay`/`interject`/
  `defer` mode selection. That is owned by the voice-spine lane.
- This spec does not implement the actual submission call from the completion
  spine to the arbiter's HTTP/queue interface, since that interface does not
  exist on this branch yet. The notification-inbox write implemented in this
  change is the durable record the arbiter (or a bridge job) will read from
  once it exists.

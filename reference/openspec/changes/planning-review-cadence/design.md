# Design: Planning & Review Cadence

## 1. The model

Eight horizons, ordered smallest to largest:

```
day -> week -> month -> quarter -> year -> five_year -> ten_year -> lifelong
```

Each horizon has a canonical, sortable `period_key` and every plan/review at
that horizon carries a `parent_horizon`/`parent_period_key` pair computed
from its own `period_key` alone (`gateway/lib/planning-cadence.js`,
`parentPeriodKey`). Nothing upstream needs to exist for the link to be
correct:

| horizon | period_key example | parent link rule |
|---|---|---|
| day | `2026-07-28` | ISO week containing that date |
| week | `2026-W31` | calendar month containing that week's Monday |
| month | `2026-07` | the quarter that month falls in |
| quarter | `2026-Q3` | the year that quarter falls in |
| year | `2026` | 5-year bucket (`2025-2029`) |
| five_year | `2025-2029` | 10-year bucket (`2020-2029`) containing its start year |
| ten_year | `2020-2029` | the constant `lifelong` |
| lifelong | `lifelong` | none (top of the chain) |

**PlanRecord** (planning side): `plan_id`, `horizon`, `period_key`,
`parent_horizon`, `parent_period_key`, `intentions` (list of
`{ text, linked_intent_id? }`), `note`, `source`, `status`,
`carried_from_review_id` (the review, if any, whose carry-forward produced
this plan), `created_at`.

**ReviewRecord** (review side): `review_id`, `horizon`, `period_key`,
`parent_horizon`, `parent_period_key`, `plan_id` (auto-resolved to the
latest plan at the same horizon+period if not supplied -- may be empty),
`status` (`completed` | `skipped`), `outcome_summary`, `carry_forward`
(same shape as `intentions`), `skipped_reason`, `source`, `created_at`.

**Linkage, concretely:**

- *Top-down (does a lifelong intention reach today?)* -- `ancestry(horizon,
  period_key)` is a pure function that walks a single day's period key up
  through week/month/quarter/year/five_year/ten_year to `lifelong` without
  touching storage. A morning-planning session calls it once, then does one
  `getPlan(horizon, period_key)` lookup per ancestor to assemble "what has
  the user said matters at every horizon above today." Any ancestor that
  was never planned is just absent from the read -- not an error.
- *Bottom-up (how does a daily review roll up into the week?)* --
  `rollup(horizon, period_key)` returns this horizon's own plan/review plus,
  for each *distinct* child-horizon period whose `parent_period_key` points
  back at it, that child's plan and review. A Sunday weekly review calls
  `rollup("week", thisWeekKey)` and gets every daily plan/review that
  happened (or was skipped) that week, with no requirement that all seven
  exist.

This is why a flat per-horizon notes list would not satisfy the
requirement: the value is that "exercise daily" (a lifelong/yearly
intention) and "ship the cadence spec" (a linked intent-plane id on
Tuesday's plan) are both reachable by walking the same chain, and a
missed Tuesday is visible in the weekly rollup as an absence, not silently
dropped.

## 2. The rituals

Two ritual shapes repeat at every horizon: a **planning** conversation that
opens the period, and a **review** conversation that closes it.

| ritual | typical trigger | horizon |
|---|---|---|
| morning planning | first voice/app open after a configurable local morning time, once per day | day (reads up through lifelong) |
| evening review | first voice/app open after a configurable local evening time, once per day | day |
| weekend review | Saturday or Sunday, once per week | week (rolls up the day) |
| monthly retro | first ritual trigger after the month rolls over | month (rolls up weeks) |
| quarterly / yearly / five-year / decade / lifelong reviews | same "first trigger after boundary" rule, lower frequency | matching horizon |

**Trigger mechanics are out of scope for this slice** (no scheduler is
added here); the contract a future trigger must satisfy is: call
`getPlan(horizon, currentPeriodKey())` and `getReview(horizon,
previousPeriodKey())` before offering the ritual, so it can tell the user
"you don't have a plan/review for X yet" instead of assuming compliance.

**What the agent does in a ritual**, given the record shape above:

- *Planning*: read `ancestry(horizon, periodKey)`, look up each ancestor's
  latest plan, look up the *previous* period's review at this horizon (its
  `carry_forward`) and any open intents surfaced by the intent plane (see
  §4). Have a spoken conversation, then call `createPlan` with the
  resulting `intentions` and `carried_from_review_id` set to that prior
  review's id when it exists.
- *Review*: read this period's plan (if any) and, for horizons above `day`,
  call `rollup(horizon, periodKey)` to see the child horizon's plans and
  reviews. Have a spoken conversation, then call `createReview` with
  `outcome_summary` and `carry_forward`.

**What happens when the user skips one**, which the brief calls out as the
common case: nothing is required to exist. `createReview` accepts
`status: "skipped"` with no `outcome_summary`; `plan_id` and
`carry_forward` are both allowed to be empty. Every rollup and ancestry
query already tolerates a missing plan or review at any horizon (proven in
`gateway/test/planning-cadence.test.js`: "the month above a skipped week
must still resolve cleanly"). Concretely: missing a week does not corrupt
the month, because the monthly rollup just returns fewer weekly children
-- it never requires all four/five weeks to be present, and the month's
own `parent_period_key` link to the quarter does not depend on the week
existing at all.

A ritual UI/trigger is intentionally left to a follow-up change once this
record shape is proven; §1's model is what everything else depends on.

## 3. Voice-first

These are conversations, not forms. A planning or review ritual is a single
spoken exchange -- the agent opens with what it already knows, the user
talks, the agent proposes a `createPlan`/`createReview` call as a **server
proposal**, never an executable command (per `AGENTS.md`'s
non-negotiable boundary): the client surface still confirms before the
write lands, exactly like any other agent-proposed action.

Before the conversation starts, the agent needs:

- **Prior plans up the chain** -- `ancestry()` + `getPlan()` per ancestor
  (§1). This is what lets "exercise daily" said once at the yearly horizon
  keep showing up every morning without the user repeating it.
- **What actually happened** -- the most recent review at this horizon
  (`getReview(horizon, previousPeriodKey)`) for its `carry_forward`, and
  for review rituals, `rollup()` into the child horizon.
- **Open intents** -- see §4.
- **Durable facts about the user** -- read from the Brain
  (`gateway/lib/brain.js`'s `recallStandingFacts()`/`recall()`), not stored
  again here. A cadence session that needs "the user is training for a
  half marathon" pulls it from the Brain; it does not duplicate it into a
  plan record's `note` field as a second source of truth.

This change does not implement the voice session itself (that is a
follow-up once the record shape lands); it defines the read contract above
so that implementation has no ambiguity about where each piece of context
comes from.

## 4. Connection to work already running

Ongoing intents live in the intent plane
(`gateway/lib/intent-plane.js`/`intent-plane-handlers.js`,
`GET /v1/intent-plane` for the projection, `GET
/v1/intent-plane/intents/:id/explain` for one intent's agents/runs/
artifacts). This change does not modify that lifecycle or its routes.

What a planning ritual needs from it: the active-intent projection
(`status !== "completed" && status !== "cancelled"`), filtered to intents
whose `next_action` is non-empty, to surface as candidates for "what should
today's plan include." A plan's `intentions[].linked_intent_id` is simply
one of those `intent_id` values, stored opaquely (never validated against
the intent plane -- this store must keep working even if the intent plane
is briefly unavailable, matching the Brain's fail-soft pattern).

What a review ritual needs from it: for each `linked_intent_id` referenced
by the period's plan, the intent plane's `explain(intent_id)` to report
current status/`latest_recap`, so "did this move forward" can be answered
from the intent plane's own progress events rather than re-asking the user
to restate status that already exists.

No intent lifecycle field, status enum, or notification is added, changed,
or duplicated here. The parallel lane (`feat/intent-notify-20260729`) owns
intent lifecycle and notification delivery; this change only reads the
existing projection/explain routes.

## 5. Scale honestly

What generalizes to a team without redesign: the record shape
(plan/review, horizon, period_key, parent linkage, carry-forward) and the
event-substrate storage pattern are per-principal already -- nothing here
assumes a single global user. A team's shared weekly review is
structurally the same rollup query over the same horizon chain.

What does not generalize without new work: authorization scoping ("who can
read/write which principal's plans"), any notion of a team-level horizon
distinct from an individual's, aggregating multiple people's daily plans
into one team standup view, and reconciling divergent horizon boundaries
(a team's fiscal quarter vs. an individual's calendar quarter). None of
that is speculatively built here.

**Trigger for a team phase**: build it only once a second gateway
principal actually exists and needs to read another principal's cadence
records (i.e., once multi-principal auth exists at the gateway level at
all -- today the gateway is single-authenticated-principal, per
`intent-plane.js`'s own authority note). Building team support earlier
would mean guessing at an auth model this repo does not have yet.

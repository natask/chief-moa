# Planning & Review Cadence

## ADDED Requirements

### Requirement: nested horizons have deterministic parent linkage

The gateway SHALL support eight planning/review horizons -- day, week,
month, quarter, year, five_year, ten_year, lifelong -- ordered smallest to
largest. Every plan or review record SHALL carry a `parent_horizon` and
`parent_period_key` computed deterministically from its own horizon and
`period_key`, independent of whether any record exists at the parent
horizon.

#### Scenario: a day's parent chain resolves without any parent records

- WHEN a plan is created for horizon `day` with no plan or review ever
  created at `week`, `month`, `quarter`, `year`, `five_year`, `ten_year` or
  `lifelong`
- THEN the day plan's `parent_horizon` is `week` and `parent_period_key` is
  the ISO week containing that day
- AND creating the plan does not require or create any parent-horizon
  record.

#### Scenario: ancestry walks a day up to lifelong without storage access

- WHEN the ancestry of a `day` horizon and period key is computed
- THEN it returns the ordered chain day, week, month, quarter, year,
  five_year, ten_year, lifelong with each entry's correct period key
- AND the computation touches no stored plan or review record.

### Requirement: reviews link to plans and roll up children without requiring either to exist

A review record SHALL auto-resolve its `plan_id` to the latest plan at the
same horizon and period when not supplied, and MAY have an empty
`plan_id`. A rollup query for a horizon and period SHALL return that
period's own plan and review (either possibly absent) plus, for every
distinct child-horizon period whose parent link points back at it, that
child period's plan and review.

#### Scenario: reviewing a period with no plan is valid

- WHEN a review is created for a horizon and period that has no plan
- THEN the review is created with an empty `plan_id`
- AND no error is raised.

#### Scenario: a skipped week does not corrupt its month

- GIVEN a monthly period with no plan or review of its own
- AND exactly one weekly review under it recorded as `status: "skipped"`
- WHEN the month's rollup is queried
- THEN the month's own plan and review are absent without error
- AND the rollup's children list contains exactly the one skipped week
- AND no other week is fabricated or required to exist.

#### Scenario: a rollup unions plans and skip-only reviews per child period

- GIVEN a week with a plan and completed review for one day and only a
  skipped review (no plan) for a second day
- WHEN the week's rollup is queried
- THEN the children list contains exactly those two distinct day periods
- AND each child reports its own plan and review independently.

### Requirement: cadence records never duplicate intent or memory ownership

A plan or review's reference to an intent SHALL be an opaque
`linked_intent_id` string that this store neither validates nor
dereferences. This store SHALL NOT persist durable facts about the user
that belong to the existing memory store.

#### Scenario: an intent reference is stored opaquely

- WHEN a plan is created with an intention whose `linked_intent_id`
  references an intent that does not exist in the intent plane
- THEN the plan is created successfully
- AND the reference is stored and returned unchanged.

### Requirement: idempotent creation and durable rehydration

Plan and review creation SHALL be idempotent by idempotency key, matching
the event-substrate pattern used by the intent plane. All plan/review
state SHALL rehydrate from the event log alone after a process restart,
with no in-memory state required.

#### Scenario: replaying the same creation returns the same record

- WHEN a plan is created twice with the same idempotency key and identical
  fields
- THEN both calls return the same record
- AND a differing payload under the same idempotency key is rejected.

#### Scenario: a new gateway runtime rehydrates cadence state

- GIVEN plan and review events exist in the event substrate
- WHEN a new planning-cadence runtime reads the substrate
- THEN it returns the same plans, reviews and rollups as the runtime that
  created them.

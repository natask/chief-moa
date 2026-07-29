# Proposal: Planning & Review Cadence

Chief Moa should help the user run a personal cadence of planning and review
across nested time horizons -- day, week, month, quarter, year, five year,
ten year, lifelong -- each with a morning-side plan and an evening/periodic
review, so an ongoing intent keeps making forward progress and a lifelong
intention is traceable all the way down to what happens today.

This is not a second intent tracker. Intentions and their execution state
stay owned by the intent plane (`gateway/lib/intent-plane.js`); a plan or
review here only carries an opaque `linked_intent_id` reference into it.
Durable facts about the user (name, preferences, standing context) stay
owned by the Brain (`gateway/lib/brain.js`); a cadence session reads from it
rather than storing a second copy of who the user is.

The slice in this change is the plan/review record shape and its
cross-horizon linkage: every plan or review at horizon H deterministically
knows its horizon-H+1 parent period, and a horizon-H+1 record can query all
of its horizon-H children. That linkage is computed from the period key
itself, not from a required upstream record, so a horizon the user never
plans or reviews (most weeks, most months) does not block or corrupt the
horizons above or below it. This is the load-bearing piece: rituals, voice
UX and cross-surface views all sit on top of it and are out of scope for
this slice (see `design.md` for what they will need and why they are
deferred).

Team support is explicitly a later phase. This change assumes a single
gateway principal and does not add a team/shared-cadence data model; see
`design.md` for the concrete trigger that would justify one.

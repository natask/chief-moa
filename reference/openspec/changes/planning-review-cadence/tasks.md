# Tasks

- [x] Define the nested-horizon period-key math (day..lifelong) and its
      deterministic parent-linkage, with no dependency on parent records
      existing (`gateway/lib/planning-cadence.js`).
- [x] Add event-sourced plan/review create, get, list and rollup over the
      existing product-event substrate, idempotent and restart-safe.
- [x] Add authenticated `/v1/planning-cadence` routes
      (`gateway/lib/planning-cadence-handlers.js`, wired in `server.js`).
- [x] Prove skip-tolerance: a missing/skipped child or parent period never
      blocks or corrupts a rollup or parent-chain lookup (unit + route
      tests).
- [ ] Wire a ritual trigger (morning planning / evening review / weekend /
      monthly / quarterly / yearly / lifelong) into a client surface or
      scheduler. Contract for that trigger is recorded in `design.md` §2.
- [ ] Build the voice-first planning/review session that reads
      `ancestry()`, prior reviews, open intents (via the intent plane) and
      standing facts (via the Brain) per `design.md` §3, and proposes
      `createPlan`/`createReview` calls for client confirmation.
- [ ] Surface a linked-intent's current status/`latest_recap` from the
      intent plane's `explain()` inside a review conversation, per
      `design.md` §4.
- [ ] Native views in MoaMac, Android, browser, web/ag.app and future
      iPhone for browsing plans/reviews and their rollups.
- [ ] Team-phase cadence support, only once multi-principal gateway auth
      exists (trigger recorded in `design.md` §5).

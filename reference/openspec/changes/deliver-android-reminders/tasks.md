# Tasks: Android Reminder Delivery

- [x] Define the `notification.reminder` input, target, claim, receipt,
  deduplication, and delivery projection contract.
- [x] Add deterministic gateway queueing for exactly one opted-in Android
  device and idempotent terminal delivery projection.
- [x] Add Android capability gating, canonical pre-display revalidation,
  notification display, and durable receipt handling.
- [x] Add restart/idempotency gateway coverage and Android binding tests.
- [ ] Confirm on a physical Android phone that the due reminder is visible,
  opens Ag, and projects `displayed` at the gateway.

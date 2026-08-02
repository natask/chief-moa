# Tasks: Gateway-Owned Reminders

- [x] Add an event-backed, user-scoped reminder store with idempotent create,
  due, and cancel transitions.
- [x] Add authenticated create/list/get/cancel HTTP routes.
- [x] Expose create/list/cancel to the cascaded voice classic and code-mode tool
  catalogs, with explicit delivery-gap language.
- [x] Add restart smoke coverage proving the deadline survives process loss and
  becomes due without claiming delivery.
- [x] Define `notification.reminder` input, claim, receipt, deduplication, and
  Android target delivery projection contracts in `deliver-android-reminders`.
- [ ] Implement and physically verify reminder delivery on each opted-in
  Surface before changing `delivery.status` from `not_configured`.
- [ ] Add typed-chat tool routing if typed chat gains the shared model-tool loop.

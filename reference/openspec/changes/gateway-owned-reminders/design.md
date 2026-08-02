# Design: Gateway-Owned Reminders

## Ownership

The gateway owns the internal reminder record, deadline, and lifecycle. The
record lives in the existing product event substrate in both Postgres and the
atomic JSONL fallback.

```text
spoken/typed request
  -> reasoning tool or authenticated reminder API
  -> reminder.created product event
  -> restart-safe deadline in the event payload
  -> gateway sweep/read appends reminder.due once
  -> delivery remains not_configured
```

A future delivery slice may turn a due event into one or more bounded
`notification.reminder` tool requests. Each target Surface must advertise that
tool, claim it, enforce its local notification policy, and receipt display or
rejection. The gateway may then project per-target delivery state. It must not
infer delivery from queue creation.

## Event Contract

- `reminder.created`: full user-scoped reminder projection, source refs,
  explicit `due_at`, and `delivery.status=not_configured`.
- `reminder.due`: idempotent scheduled-to-due transition, appended by the
  gateway scheduler under the reminder stream lock.
- `reminder.canceled`: idempotent user cancellation.

Each reminder uses stream `reminder:<reminder_id>`. Creation accepts an optional
idempotency key. When present, user id plus that key deterministically derive
the reminder id, so an HTTP or model-tool retry cannot create a second timer.

## API

- `POST /v1/reminders`: `{ message, due_at | delay_seconds,
  idempotency_key?, source? }`.
- `GET /v1/reminders`: list, optionally filtered by `status`.
- `GET /v1/reminders/{id}`: inspect one owned reminder.
- `POST /v1/reminders/{id}/cancel`: cancel one owned reminder.

Absolute `due_at` values require an explicit ISO 8601 timezone. Relative
deadlines accept up to one year in seconds. The store computes and persists one
absolute timestamp at creation; it never reconstructs the deadline from a
process-local timer after restart.

## External App Boundary

`kind` values other than `internal`, or fields naming a timer/reminder app, are
rejected. “Use Clock to set a timer” must enter the device tool hub as a named,
locally validated action only after that Surface exposes such a capability.
This gateway route never taps or controls an app.

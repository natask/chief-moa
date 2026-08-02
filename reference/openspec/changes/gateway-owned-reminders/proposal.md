# Gateway-Owned Reminders

## Why

The user should be able to say “remind me in ten minutes” without selecting a
third-party timer application. That intent belongs to Ag and must survive a
gateway restart. Asking Ag to use a named Clock, timer, or reminder app remains
a different, explicit device-local action owned by the target Surface.

The gateway already has a durable event substrate and model-tool loop. The
first slice preserves the deadline without pretending that a due reminder
reached a person. The staged `deliver-android-reminders` change adds one bounded
Android delivery adapter; browser and desktop delivery remain absent.

## Outcome

- Authenticated users can create, list, inspect, and cancel internal reminders.
- Relative and absolute deadlines become durable product events.
- A gateway restart cannot lose a scheduled reminder; the next sweep or read
  materializes its `due` state idempotently.
- Cascaded voice reasoning can call the same create/list/cancel operations.
- Every reminder reports delivery as `not_configured` until one compatible
  client delivery contract is advertised; Android may then project queued and
  exact receipted status under `deliver-android-reminders`.
- Inputs naming an external timer/reminder app are rejected from this internal
  route and require a separate local-action proposal.

## Non-Goals

- This base slice alone makes no delivery claim. Android delivery is separately
  scoped by `deliver-android-reminders`; browser notifications, sound, speech,
  email, and push remain out of scope.
- No recurring reminders, snooze, calendar synchronization, or timezone
  inference in the first slice.
- No gateway execution of phone UI or external timer applications.

# Deliver Gateway-Owned Reminders On Android

## Why

Gateway reminders now survive restart and become due, but
`delivery.status=not_configured` correctly says no person was notified. Android
already has the authenticated device-tool claim/receipt loop and notification
permission onboarding, so it can own one bounded delivery adapter without
inventing push delivery or allowing the gateway to execute phone UI.

## Outcome

- Android advertises `notification.reminder` only while its notification
  permission and app/channel policy permit delivery.
- The gateway queues one deterministic request only when exactly one compatible
  Android device is online.
- Android re-reads and validates canonical due state, target device, request id,
  message, and deadline immediately before it posts the notification.
- A durable, claim-bound receipt projects delivery as `displayed` or `failed`.
- Restart and receipt retry create neither a second request nor a second
  delivery transition.

## Non-Goals

- No FCM, wake-up push, WorkManager polling, browser/desktop delivery, recurring
  reminder, snooze, external Clock control, or claim that an offline phone was
  notified.
- No claim of physical-device delivery until phone QA confirms it.

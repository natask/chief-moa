# Design: Android Reminder Delivery

The existing cross-device tool hub is the transport and authority boundary.
The gateway keeps deadline state; Android keeps notification permission and
display authority.

```text
reminder.due
  -> exactly one online Android advertises notification.reminder
  -> deterministic tool request is queued and linked by reminder event
  -> Android claims and re-reads GET /v1/reminders/{id}
  -> exact due/request/device/content binding passes
  -> NotificationManager accepts an active notification
  -> Android durable receipt outbox posts the bound terminal receipt
  -> reminder delivery projects displayed or failed
```

The queue identity derives from reminder plus target device. A restart retries
that exact identity. Queue creation is not delivery. Only the claimant's exact
terminal receipt changes the reminder delivery projection. Android omits the
capability when notification permission, app notification policy, or the
reminder channel is disabled. A canceled, retargeted, mutated, or stale
reminder fails revalidation and is receipted as failed without notifying.

This slice depends on the existing foreground companion device loop. It does
not wake a stopped application. An offline or stopped phone therefore leaves a
due reminder at `not_configured` until one opted-in client is online.

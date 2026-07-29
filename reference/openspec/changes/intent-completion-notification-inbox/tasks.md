# Tasks

## 1. Notification Inbox (implemented in this change)

- [x] 1.1 Add `listNotifications` (filter by `receipt_state`, `kind`,
  `intent_id`; paginated) and `dismissNotification` (distinct terminal state,
  never downgrades `received`) to `gateway/lib/intent-plane.js`.
- [x] 1.2 Add a `silent` hint to `createNotification`, stored and returned.
- [x] 1.3 Expose `GET /v1/intent-plane/notifications` and
  `POST /v1/intent-plane/notifications/:id/dismiss` in
  `gateway/lib/intent-plane-handlers.js`.
- [x] 1.4 Wire `gateway/lib/broker-completion-spine.js` to accept an optional
  `notificationInbox` dependency and best-effort post one inbox entry per
  terminal `agent_run`, tagged `agent_output_ready` (silent) or
  `agent_run_stopped` (non-silent), idempotent on retry, never failing
  `complete()` if the inbox write throws.
- [x] 1.5 Wire `gateway/server.js` to construct `intentPlane` before the
  completion spine and pass it as `notificationInbox`.
- [x] 1.6 Tests: `gateway/test/intent-plane.test.js`,
  `gateway/test/intent-plane-routes.test.js`,
  `gateway/test/broker-completion-spine.test.js`.

Acceptance: `GET /v1/intent-plane/notifications?receipt_state=pending` lists
notifications from both intent-plane's own transitions and the broker
completion spine, without requiring the caller to page through intents. A
broker-completion-spine terminal result produces exactly one inbox entry,
even on idempotent retry, even when the linked intent id only exists in the
intent-runtime pipeline.

Verification:

```sh
cd gateway
node --test test/intent-plane.test.js test/intent-plane-routes.test.js test/broker-completion-spine.test.js
npm run check
```

## 2. Intent Lifecycle Scheduler (specified only; not implemented here)

- [ ] 2.1 Implement a periodic tick that calls `intentRuntime.neglected()` and
  issues one bounded re-drive attempt per stalled intent through the existing
  broker/switchboard launch path.
- [ ] 2.2 Implement growing-interval backoff and a maximum attempt count per
  intent before it transitions to `blocked` and stops auto-retrying.
- [ ] 2.3 Post a non-silent `intent_stalled` notification-inbox entry when
  automatic retry is exhausted (uses the inbox this change already ships).

## 3. Intent Completion Delivery (specified only; blocked on
   `feat/voice-spine-20260729`)

- [ ] 3.1 Once the delivery arbiter's ingestion point exists, submit a
  `background`-tier delivery proposal from the completion spine (or a small
  bridge job reading the notification inbox) instead of, or in addition to,
  the current best-effort inbox write.
- [ ] 3.2 Confirm with the voice-spine lane that `background` tier is
  never `interject`-eligible against an in-flight reply, and that the
  `silent` hint is honored as described in the `intent-completion-delivery`
  spec.

## 4. Client Adapters (out of scope for this change)

- [ ] 4.1 Android notification channel adapter reading
  `GET /v1/intent-plane/notifications`, respecting the user's own per-channel
  settings.
- [ ] 4.2 Browser Notification adapter, permission-gated by the user.
- [ ] 4.3 Voice-agent read/dismiss/receive access to the same endpoints
  (no new voice-only store).

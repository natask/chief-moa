## ADDED Requirements

### Requirement: Reminder notification is an advertised Android capability
Android SHALL advertise `notification.reminder` only when the app can post a
notification under current OS permission and channel policy.

#### Scenario: Notification access is unavailable
- **WHEN** notification permission, app notifications, or the reminder channel
  is disabled
- **THEN** Android omits `notification.reminder` from its tool manifest
- **AND** the gateway does not queue reminder delivery to that device

### Requirement: Delivery binds canonical reminder state
Before posting, Android SHALL re-read the reminder and require exact due status,
reminder id, tool request id, target device id, message, and deadline.

#### Scenario: Reminder was canceled after queueing
- **WHEN** Android claims a request whose canonical reminder is canceled
- **THEN** Android posts no notification
- **AND** returns a bound failed receipt

### Requirement: Queue and receipt are restart-idempotent
The gateway SHALL derive one request identity per reminder and target device,
and SHALL project delivery only from that request's bound terminal receipt.

#### Scenario: Gateway restarts around delivery
- **WHEN** the gateway restarts before or after the Android receipt is stored
- **THEN** retry resolves to the same tool request and delivery event
- **AND** no second request or terminal transition is created

### Requirement: Delivery state is honest
The gateway SHALL distinguish `not_configured`, `queued`, `displayed`, and
`failed`. Queue creation alone SHALL NOT project `displayed`.

#### Scenario: Android notification is active
- **WHEN** the bound Android claimant confirms the notification is active and
  posts its durable success receipt
- **THEN** the reminder projects `delivery.status=displayed`
- **AND** the projection names the exact request and target device

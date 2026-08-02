# Gateway-Owned Reminders Specification

## ADDED Requirements

### Requirement: Durable Internal Deadline

The gateway SHALL persist an internal reminder and its absolute deadline in the
canonical product event substrate.

#### Scenario: Gateway restarts before the deadline

- **GIVEN** an authenticated user created a scheduled reminder
- **WHEN** the gateway process stops and starts after its deadline
- **THEN** a sweep or reminder read appends one idempotent due transition
- **AND** the reminder projects as `due`

### Requirement: Honest Delivery State

The gateway SHALL distinguish a due reminder from a delivered reminder.

#### Scenario: No Surface delivery capability exists

- **WHEN** an internal reminder becomes due
- **THEN** its delivery status remains `not_configured`
- **AND** the gateway does not claim the user was pinged, notified, or alerted

### Requirement: External Timer Apps Remain Local Actions

The internal reminder route SHALL NOT control a named timer or reminder app.

#### Scenario: Request names an external app

- **WHEN** creation names a timer/reminder application or a non-internal kind
- **THEN** the gateway rejects it with a separate-device-action explanation
- **AND** it creates no internal reminder

### Requirement: User Scope And Idempotency

Reminder reads and mutations SHALL enforce the authenticated user boundary, and
creation retries with one idempotency key SHALL resolve to one reminder.

#### Scenario: Creation is retried

- **WHEN** one user retries reminder creation with the same idempotency key
- **THEN** both requests resolve to the same reminder id
- **AND** another user cannot read or cancel that reminder

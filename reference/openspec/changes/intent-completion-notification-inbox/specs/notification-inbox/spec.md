# Notification Inbox

## Context

`gateway/lib/intent-plane.js` already has a notification store on the shared
event substrate: `createNotification`, `receiveNotification`, a
`receipt_state` field, and an idempotent auto-fire on `completed`/`needs_user`
intent-plane transitions. This change generalizes it into the one
cross-surface inbox rather than building a second store, and wires the
broker-completion-spine's terminal result into it.

The inbox is gateway-owned because the user wants it "across surfaces": one
durable list that Android, browser, and the voice agent all read from and
act on, independent of which lifecycle system (intent-plane's own status
transitions, or the intent-runtime/broker-completion-spine pipeline) produced
an entry.

## ADDED Requirements

### Requirement: A notification record

A notification record SHALL contain: `notification_id`, `intent_id` (may
belong to either the intent-plane's own intents or the intent-runtime
pipeline's intents — this store does not require the referenced intent to
exist in its own intents map), `kind`, `title`, `message`, a `silent` hint
(producer-suggested only; never a client-facing override of OS notification
settings), `receipt_state` (`pending` / `received` / `dismissed`), `receipt`
(actor, note, timestamp, once received), `dismissal` (actor, timestamp, once
dismissed), `created_at`, `updated_at`.

#### Scenario: a notification is created for an intent-runtime-sourced intent id

- GIVEN an intent id produced by `gateway/lib/intent-runtime.js`, not by
  `intent-plane`'s own `createIntent`
- WHEN a notification is created against that intent id
- THEN the notification is stored and listable
- AND no intent-plane intent record is required to exist for that id.

### Requirement: Dismiss is distinct from receive

The inbox SHALL keep "the user swiped it away" (`dismissed`) and "the user
opened it and acted on it" (`received`) as separate terminal receipt states,
matching native notification paradigms. A `dismiss` request MUST NOT
downgrade a notification that has already been `received` back to
`dismissed`.

#### Scenario: dismissing an unopened notification

- GIVEN a notification with `receipt_state: pending`
- WHEN it is dismissed
- THEN its `receipt_state` becomes `dismissed`.

#### Scenario: dismissing an already-received notification is a no-op

- GIVEN a notification with `receipt_state: received`
- WHEN a dismiss is requested for it
- THEN its `receipt_state` remains `received`.

### Requirement: The inbox is directly listable and filterable

The gateway SHALL expose a list endpoint over notifications that does not
require paging through intents first, filterable by `receipt_state` and
`kind`, and optionally scoped to one `intent_id`.

#### Scenario: the user asks "what's pending"

- GIVEN notifications exist across several unrelated intents
- WHEN a caller requests the inbox filtered to `receipt_state=pending`
- THEN the response contains exactly the pending notifications, independent
  of how many distinct intents produced them or which page an intent-scoped
  view would put them on.

### Requirement: Intent completion lands in the inbox regardless of source

The gateway SHALL produce exactly one notification-inbox entry, idempotent on
retry, for a terminal result recorded through the broker completion spine
(the intent-runtime/work-history pipeline), independent of intent-plane's own
`updateIntent` transitions.

#### Scenario: a broker-launched agent run completes

- GIVEN an intent was created and driven entirely through the intent-runtime
  and broker-completion-spine pipeline (never through `intent-plane`'s
  `createIntent`/`updateIntent`)
- WHEN its linked agent run reaches a terminal state
- THEN one notification-inbox entry is created for that intent id
- AND retrying the same terminal-result call produces no second entry.

### Requirement: A broken inbox never fails the completion it reports on

Writing the notification-inbox entry is best-effort. Its failure MUST NOT
fail the broker-completion-spine's `complete()` call or lose the
intent-runtime's own durable notification record.

#### Scenario: the notification inbox dependency throws

- GIVEN the completion spine is configured with a notification-inbox
  dependency that throws on every call
- WHEN an agent run reaches a terminal state
- THEN `complete()` still returns successfully
- AND the intent-runtime notification (`pending_notifications`) is still
  recorded.

### Requirement: Native per-surface delivery, not a gateway-invented paradigm

Each surface SHALL present inbox entries using its own native mechanism and
MUST respect the user's own settings for that mechanism. The gateway MUST NOT
override platform-level silent/visible/do-not-disturb settings; the `silent`
hint on a notification record is only ever a suggestion a surface adapter may
use to pick a channel/importance/urgency within what the user already
allows.

- **Android**: post through a notification channel; channel
  importance/sound/vibration follow the user's own per-channel settings in
  system settings, never a gateway-forced override.
- **Browser**: use the browser's own Notification mechanism (permission-gated
  by the user, respecting the OS/browser's own do-not-disturb state).
- **Voice agent**: the voice agent reads and can act on inbox entries through
  the same list/receive/dismiss endpoints this capability exposes (no
  separate voice-only notification store), but it must still never speak an
  entry in a way that violates the no-interrupt rule owned by
  `intent-completion-delivery`.

#### Scenario: the user has silenced a channel on their phone

- GIVEN an Android notification channel the user has set to silent in system
  settings
- WHEN an inbox entry with `silent: false` is delivered to that channel
- THEN the phone respects the user's channel setting (silent), not the
  record's suggested hint.

## Non-Goals

- This spec does not implement the Android channel adapter or the browser
  Notification adapter. It defines the record shape and inbox surface those
  adapters are built against.
- This spec does not change the voice agent's turn-parsing/intent-recognition
  pipeline to add new spoken inbox commands ("read my notifications"); it only
  requires that the same HTTP surface used by other clients is available for
  the voice agent to call.

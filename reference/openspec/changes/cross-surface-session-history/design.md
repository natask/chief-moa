# Design: Cross-Surface Session History

## Intent Resolution

The first milestone is not a new chat product. It is a shared read model over
records Chief Moa already owns, projected into the two surfaces intended for
durable inspection:

```text
Android text/voice turn ----\
                              -> gateway canonical session messages
browser text/voice turn ----/             |
                                            |-> browser side-panel workspace
                                            `-> Android full-app history

browser on-page overlay -> current/latest transient cue + History handoff
Android floating overlay -> current/latest transient cue + full-app handoff
```

The gateway remains the source of truth. Neither client becomes a second
conversation database.

## Canonical Session-Message Projection

The gateway SHALL expose an authenticated, deterministic latest-N projection for
one authorized session and optional branch. Each projected message contains:

- `message_id`: stable canonical projection identity;
- `session_id`, `branch_id`, and `turn_id` when available;
- `source_surface`: at least `android` or `browser`;
- `source_kind`: at least `text` or `voice`;
- `speaker`: `user` or `assistant`;
- exact user-authored text or final transcript when retained;
- assistant display text when retained, without fabricating text for an
  audio-only provider result;
- `created_at`, completion state, and incomplete/canceled status;
- bounded links to intent, broker event, work task, agent run, action proposal,
  and receipt evidence when those records exist; and
- projection provenance sufficient to diagnose missing or deduplicated source
  records without returning raw provider payloads.

The request limit is bounded by a documented server maximum. The gateway selects
the latest N canonical messages and returns the newest turn first. Within one
turn, it returns the user message before the assistant message. A deterministic
canonical identity tie-break resolves equal turn times. The endpoint reports the
applied limit, returned count, available count when known, included counts by
surface/kind, and excluded/unreadable counts. Cursor-complete export and
time-window snapshots stay with the `historical-intent-to-implementation`
follow-on rather than this UI recovery wave.

### Deduplication

One accepted user turn may be mirrored as a voice/chat turn, broker event, and
product event. The projection emits one user message, not one row per backing
store. Deduplication prefers exact turn/message causation links and may use an
explicit canonical-source priority. Text similarity alone is insufficient to
merge two messages.

Assistant output is a separate projected message correlated to its user turn.
An incomplete turn retains the partial transcript or assistant text the gateway
actually stored and is visibly marked incomplete.

### Privacy And Authorization

- An incognito turn never appears because it was never persisted.
- Gateway authentication and session ownership are checked before records are
  read.
- A client cannot select another device's private local store through request
  parameters.
- Screen/page evidence bodies, credentials, cookies, accessibility trees, and
  raw provider events are excluded from this projection.
- Receipt summaries are read-only evidence and grant no action authority.

## Browser Surface Ownership

### Durable side-panel workspace

The extension-owned side panel is the durable browser interaction surface. It:

- requests canonical messages through the background worker;
- renders user and assistant messages with source, completion, and bounded
  status/receipt references;
- preserves live in-flight progress locally, then reconciles it with the
  canonical projection when a terminal record becomes available;
- reloads after side-panel close/reopen or service-worker restart, exposes a
  visible retry on load failure; and
- follows the stable gateway session rather than a content-script-local cue id.

This wave does not require a last-good client cache. If the implementation keeps
an existing bounded display value during a retry, it must not present that value
as a fresh canonical read.

### Browser transcript-history polish

The canonical latest-N response returns the newest turn first. Browser History
uses that order directly. Each retained recording owns one outer card or
section. The card keeps the user transcript before its tied assistant response.
Cards do not split transcript revisions into peer history rows.

The newest recording appears first. Its latest completed transcript revision is
the primary result in History and uses the strongest transcript treatment.
Older recording cards follow in newest-first order. Copy uses the exact selected
transcript version. It does not copy labels, timestamps, assistant text, or
hidden metadata.

Transcript revisions use an inward stacked-card treatment inside their recording
card. The front card shows the latest completed version by default. A revision
selector or presenter lists versions in chronological revision order: original,
then each successful re-transcription. Selecting an older version brings that
version forward for reading and Copy without changing the default latest
version or creating another outer history card.

History should read as a transcript library. Its default list contains
transcript cards and the assistant response tied to each turn when one exists.
It does not repeat page identity, provider details, session selectors, agent
selectors, developer diagnostics, or duplicate current-turn status between
cards. A load error, missing-audio reason, or active re-transcription state may
appear because it changes what the user can do now. Linked run and receipt
details remain available through a secondary detail view when present.

Retained transcript display and re-transcription have separate contracts:

- A normal history read shows the stored final transcript and starts no
  provider call.
- Copy reads that stored transcript and starts no provider call.
- Re-transcribe is an explicit action shown only when the canonical message
  carries an accessible retained-audio reference.
- Every explicit Re-transcribe action starts a new attempt. There is no
  product-level one-retry limit. Operational concurrency and abuse limits may
  still reject an attempt honestly.
- Each successful attempt appends a transcript revision linked to the same
  source turn and audio. It becomes the default displayed version. It never
  overwrites or hides the original or an older revision.
- The UI labels which text is the retained original and which text came from a
  later re-transcription. It exposes Copy for each completed revision.
- A turn without retained audio stays fully readable and copyable. The UI does
  not imply that audio recovery is possible.

This unit does not change raw-audio retention defaults. It consumes only audio
that the user already retained under the existing storage policy.

### Browser workspace entry

Clicking the browser extension toolbar action opens the side-panel workspace for
this unit. It does not create a turn, start capture, or select another session.
Existing double-tap and session gestures keep their current behavior. History
search is a follow-on and does not add a search field in this unit.

### Transient on-page overlay

The on-page overlay remains optimized for immediate interaction. It may show
the current input draft, current voice transcript, current/latest answer or
error, current page identity, and a History/workspace affordance. Resolved cues
may retire. It SHALL NOT become a permanent scrollback store or retain canonical
history in the page's JavaScript context.

This separation resolves the existing tension between “one current intent” and
“I need to see my messages”: the compact page surface stays transient, while the
side panel supplies persistent inspection.

## Android Surface Ownership

The full Android application consumes the same canonical projection for session
history. It shows message source/kind, exact retained transcript/text,
assistant response when available, incomplete state, and linked work/run/receipt
status.

The floating Android overlay remains a current-turn surface: capture, live
transcript, short answer/status, stop, approval prompts, and a handoff into the
full app. It does not grow into a scrollback manager. Android retains ownership
of phone permissions, approvals, local actions, and local receipts.

## Browser Action/CDP Boundary

This recovery wave adds no browser action, CDP method, delegation scope, consent
version, or execution policy. A message may display a bounded summary and link
for an existing browser-local receipt. The extension does not claim, re-run, or
infer success from that history read.

## Failure Behavior

- An unavailable gateway shows a clear load error and retry action; it does not
  report an empty successful history response.
- Authentication failure returns no messages and prompts connection repair.
- A missing or corrupt backing record increments excluded/unreadable metadata.
- A message without assistant text remains valid; the UI labels the unavailable
  representation rather than inventing a transcript.
- A re-transcription failure leaves every retained transcript visible and
  copyable, and shows a retryable error on the affected turn.
- Missing, deleted, expired, or unauthorized audio disables re-transcription
  without disabling transcript display or copy.
- Surface restart does not duplicate a message because render identity is the
  canonical `message_id`.

## Rollout

1. Add and verify the gateway projection with seeded mixed-source fixtures.
2. Add browser side-panel loading/reconciliation in an isolated Chrome profile.
3. Add Android full-app session history and emulator/build verification.
4. Join the exact candidate in a preview gateway with separate state.
5. Package extension and Android artifacts without reloading/installing them.
6. Promote or install only after rollback, compatibility, no-interruption, and
   backup/restore gates pass and a user-safe QA window exists.

## Follow-On Outcome Map

| Outcome | Next owning change/lane | Why staged |
| --- | --- | --- |
| Continuous agents and project/intent mapping | `canonical-intent-runtime`, worker-pull, and intent-completion workflow | Requires a durable worker and completion reducer, not a history UI shortcut |
| macOS parity | Apple surface/protocol adapter change | Must consume the stable shared contract and preserve native authority |
| Windows | Windows native adapter change | Requires UI Automation, packaging, signing, and recovery evidence |
| iPhone | iOS product-surface change | Current Swift seam is not device/product evidence |
| STT evaluation | Voice evaluation/completion change | Provider testing and paid/live consent are independent of history retrieval |
| Android overlay/native/remove ergonomics | Android overlay follow-on | Requires physical-device gesture and removal QA |
| Multimodal presentation input | Unified evidence capability follow-on | Requires explicit capture grants, bounded assets, provider-use, and retention receipts |

## Source Map For Implementation

- Gateway session/history routes and extracted history store/adapter.
- `browser_extension/extension/sidepanel.html`
- `browser_extension/extension/sidepanel.js`
- `browser_extension/extension/background.js`
- `browser_extension/extension/content.js`
- `browser_extension/extension/steering-ui.js`
- `android_app/app/src/main/java/ai/moa/assistant/MainActivity.java`
- `android_app/app/src/main/java/ai/moa/assistant/MoaGatewayClient.java`
- Android full-app history models/adapters selected by the Android ticket.

Exact gateway files are selected after the gateway source lane reads the current
history implementation; this docs ticket does not invent another store.

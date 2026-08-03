# Design: macOS Look & Ask Intent Capture

## Relationship To Existing Mac Activities

Look & Ask is a separate explicit activity inside the existing singleton Mac
companion. It does not replace assistant voice, literal Dictate, proactive
observation, or the deeper Privacy & Screen Context settings surface.

The global summon records the source binding before showing/focusing Ag:

```text
user invokes Look & Ask while a source app is frontmost
  -> Mac records exact app/process generation + focused-window identity
  -> singleton Ag panel becomes visible and starts/accepts transcript capture
  -> Attach context remains off unless the user enables it for this turn
  -> optional one-shot AX capture and separately optional window screenshot
  -> local preview/redaction + freshness revalidation
  -> user submits transcript and approved evidence
  -> gateway appends one durable non-executable intent
```

Summoning from Ag itself is valid for an Ag self-report only when the UI labels
Ag as the source. If no stable focused source window can be bound, the turn may
continue transcript-only; context attachment remains unavailable rather than
guessing a prior app or window.

## Permission Separation

Three permissions/capabilities remain independent:

- **Microphone** authorizes only transcript audio capture through the existing
  voice transport. It neither reads AX nor captures pixels.
- **Accessibility** authorizes only the explicit one-shot semantic attachment
  after the user turns on Attach context. OS trust alone does not enable the
  toggle, start observation, or release evidence.
- **Screen Recording** authorizes only the separately enabled screenshot for
  the same bound focused window. It is not required for transcript or AX
  context, and denial degrades to transcript plus AX evidence when available.

The current-turn attach choices reset to off when the turn is submitted,
cancelled, dismissed, or replaced. They do not consume or inherit
`trusted_server_15m`, `ask_each_time`, or proactive observation authority.

## Exact Source And Freshness Binding

The local capture binding contains, at minimum:

```text
capture_id
source_bundle_id
source_pid
source_process_generation / launch_date
verified_signing_identity
focused_window_identity
captured_at
ax_snapshot_digest
optional screenshot digest
```

The app records the binding before its own panel changes focus. AX evidence and
the optional screenshot must both resolve to that same process and focused
window. The surface revalidates process identity and window identity before and
after each capture and again immediately before submission.

Any app switch, process replacement/PID reuse, focused-window change,
permission loss, screen lock, sleep, or capture-generation replacement marks
the attached evidence stale. Stale evidence remains visible for review but
cannot be submitted. The only continuations are explicit recapture against the
currently frontmost app/window or removal of the attachment. Transcript text is
not discarded merely because evidence becomes stale.

## Evidence Bounds And Local Redaction

Look & Ask reuses the `privacy-first-macos-surface` bounds rather than defining
a broader context path:

- AX traversal: at most 128 nodes, depth 8, 256 characters per label, and
  16 KiB serialized semantic context;
- secure-text subtrees and editable values are excluded; authentication,
  password-manager, payment, and security-settings windows fail closed;
- credentials/tokens, payment identifiers, email/phone identifiers, URL
  path/query/fragment, and home-directory identity are redacted locally;
- screenshot: same-process focused window only, public ScreenCaptureKit,
  longest edge at most 1280 pixels, re-encoded JPEG, metadata stripped, and at
  most 1 MiB.

No raw AX object, coordinate/frame, whole-desktop bitmap, or unredacted
intermediate becomes gateway evidence. Screenshot bytes remain a separately
bounded evidence asset rather than inline executable/message content.

## Review And Submission

Before network release, the panel shows:

- the exact editable transcript that will become the user-authored objective;
- source application and focused-window identity;
- the exact locally redacted semantic snapshot;
- redacted, dropped, and truncated counts;
- screenshot inclusion state plus its bounded preview, dimensions, byte count,
  and digest when enabled;
- the canonical configured gateway destination and retention statement; and
- an explicit statement that the evidence is non-executable.

Approval binds the immutable serialized intent/evidence envelope and evidence
digests. Editing the transcript, recapturing context, changing screenshot
state, destination, retention, source binding, or serialized bytes invalidates
the approval and requires a fresh preview. Redirects remain rejected.

## Durable Intent Envelope

Submission appends a versioned `macos_look_and_ask_intent.v1` record through the
gateway's canonical intent/event substrate. It contains:

- stable source turn and idempotency identity;
- exact user transcript and transcript provenance;
- session, branch, surface, capture time, and source binding metadata;
- typed AX and optional screenshot evidence refs with digests, bounds,
  redaction report, and retention policy;
- `executable: false` and an initial lifecycle of `captured` or
  `needs_alignment`;
- no task, queued run, action proposal, deployment request, or promotion fact.

Retries with the same stable submission identity return the same durable intent
identity and do not duplicate evidence admission. A later user action may cite
this intent when creating a task, authorizing implementation, or requesting an
action, but that later transition must independently satisfy its own typed
contract and authority checks.

## Authority Boundaries

AX text and pixels are untrusted evidence. They cannot change the transcript,
select a repository/project, create hidden instructions, or widen capabilities.
Any derived summary is a separately labeled, inspectable proposal and never
replaces the exact transcript.

This milestone does not consume gateway native-action proposals. If a later
turn produces an action proposal, the Mac must apply the existing closed
semantic manifest, fresh state binding, local approval, one-shot nonce, and
pending/terminal receipt contract. Intent submission itself cannot execute it.

Likewise, durable capture is not delivery completion. Tasks, agent runs,
candidate bytes, verification, preview, user acceptance, deployment,
promotion, and promoted smoke remain distinct records governed by the durable
delivery and release-control boundaries.

# Design

## Surface entrypoints and visible app identity

Ordinary typed chat, HTTP voice turns, cascaded voice reasoning, and Android
legacy-Live sessions receive the same bounded Android `phone_action` catalog.
`app.launch` carries only `app_name`; Android resolves that user-visible label
against exported launcher activities and requires exactly one match. `app.list`
returns a size- and count-bounded projection of visible launcher labels. The
gateway strips or rejects package, component, activity, intent, and target
selectors and cannot turn a model-authored application id or caller-supplied
device id into execution authority. The shared user bearer authorizes a
proposal, not a device principal: without independently authenticated device
evidence the gateway routes only when exactly one compatible Android device is
online, and fails closed as ambiguous when more than one is eligible.

## Device-local media authority

An enabled `NotificationListenerService` is the user-granted bridge to
`MediaSessionManager.getActiveSessions`. Android selects an active YouTube-like
session by current playback priority, captures a bounded media fingerprint, and
uses only advertised `PlaybackState` actions. Seek and transport commands bind
to the observed package and media fingerprint; stale state fails closed.

`media.open` prefers a validated YouTube HTTPS URI/video id, then an active
session's `playFromUri`/`playFromSearch`, then a package-bound search intent.
Android resolves a locally stored preferred-app alias to a currently installed
handler. The product default maps `YouTube` to the installed Advanced/ReVanced
package, while explicit user-visible names may select ReVanced or stock YouTube
for one request. Future variants use the same capability only after a local
named mapping is saved; a model-selected package name has no authority. The
selected package and signing/version evidence are bound to execution.

`media.open` receipts describe the strongest locally observed outcome. Opening
a search or sending a watch URI is not playback success. Search operations use
`search_opened`, `needs_accessibility`, or `selection_unverified`; only a unique
title/channel match clicked and confirmed by the approved fixture may use
`selection_verified`. `playback_verified` is reserved for a fresh observable
media-session postcondition and is not inferred from an intent launch.

Accessibility is reserved for visible states that MediaSession cannot express,
not for arbitrary model-authored tap sequences. An undocumented variant adapter
is a named, versioned local module with declared package/signature constraints,
supported version range, bounded selectors/state transitions, and fixtures. An
unknown version, signature change, missing selector, ambiguous state, or UI drift
disables that adapter and returns a receipt rather than guessing.

VLC is resolved separately and only on-device from the visible `VLC` label among
exported handlers for the validated source. `media.open` may hand VLC an explicit
HTTPS or `content://` URI with read permission; it rejects file paths, `file://`,
intent URIs, model-authored packages, missing or ambiguous handlers, and weak
title-only identity. A title-only request returns `needs_source` until a catalog
or source connector supplies a concrete URI, and never claims playback.

## Saved spots and cross-surface recall

Bookmark admission requires a real syntactically valid YouTube `video_id` parsed
from a canonical URL, strong MediaSession identity, or a versioned adapter's
bounded extraction. `identity_strength` records that provenance
(`canonical_uri`, `session_media_id`, or `adapter_extracted`); `title_only` and
other weak fallbacks are never admissible bookmark identities.

After an explicit remember action, the owning surface stores locally and syncs
only a bounded approved record through the gateway: bookmark id, provider,
video id, position, label, optional bounded note/title, source surface, and
created/updated times. No page body, accessibility tree, media-session token,
package signature, cookie, auth header, or raw audio is synced. Resolution ranks
exact label, phrase containment, then bounded normalized-token overlap across
approved textual bookmark fields; ties are ambiguous. Spoken recall uses the
transcript through that same resolver. Raw audio fingerprints or audio-to-video
matching are not stored or compared in this change. Any authorized Android or
browser surface may read the record and locally open the canonical video id at
its timestamp.

The browser parses only canonical YouTube watch, short-link, and supported
shorts URL shapes, may read the current HTML media position after an explicit
bookmark gesture, and can open the canonical URL with `t`. A query-only open
uses a local YouTube results tab and a bounded observation; execution requires
one exact normalized title, additionally one exact channel when supplied. Zero
or multiple matches fail closed. It needs no OAuth, cookie access, CDP, or
authenticated browser-agent task.

## Durable local execution and convergence

Claiming and executing are distinct durable transitions. A surface records the
gateway request id, claim id, generated receipt id, and execution state locally
before the effect; after the effect it persists the canonical terminal receipt
in a bounded outbox. A restarted surface suppresses duplicate execution and
retries only receipt delivery. The gateway accepts a terminal result only from
the current target/claimant with the exact live claim before lease expiry;
identical terminal retries are idempotent and conflicting retries fail closed.

Bookmark synchronization uses the same refusal-to-forget rule. Create and
delete intents enter bounded durable outboxes, and delete records are written as
tombstones before a local bookmark disappears. Reads suppress a tombstoned
gateway record until the remote delete is acknowledged. Full queues refuse new
work and retain every unacknowledged record; they never evict the oldest record.

## Playlist adapter and approval

Playlist operations are fixed Android-owned state machines with operation id,
expiry, expected package/window, known resource/text fingerprints, bounded
traversal, and one terminal receipt. Mutations pause at an overlay confirmation
bound to the tool request and canonical argument digest. Approval materializes
the installed package, version code, signer digest, UI-profile version, active
window, and—where the operation concerns the current video—video id/title/media
fingerprint. Execution rechecks every binding. Success additionally requires a
fresh bounded postcondition: the exact checkbox membership changed, the new
playlist name is uniquely visible, rename shows the new name and not the old
one, or delete shows the old name absent. Package/UI drift, expiry, rejection,
ambiguity, or an unobservable postcondition produces a failure receipt.

## Overlay geometry and gestures

The orb and one mutually exclusive chat/voice card form an anchored group. The
card is wholly above the orb with a gap when it fits and flips wholly below near
the top. Orb drag and card-header drag update the same anchor. Drag-to-remove or
Hide stops the service; Close cancels the active draft/card but retains the orb.

Transcript text is selectable. A pure gesture policy does not arm row dismissal
while selection/action mode is active; after selection clears, equal left and
right horizontal thresholds produce the same cascade.

## Rollout

Gateway execution routing remains additive; the bookmark collection is a new
bounded user record and must have isolated preview storage plus backup/restore
evidence before promotion. Android and browser keep additive local bookmark
caches and treat the gateway record as cross-surface recall authority after a
successful approved sync.
The Android candidate must be tested on the installed YouTube variant because
media ids, actions, and Accessibility resource ids vary by build. Unsupported
variants return a receipt rather than guessing.

Android OTA publication preserves rollback evidence as part of the rollout
boundary. The publisher validates a byte-consistent local release, acquires one
remote owner lock, verifies and snapshots the prior `current` state, stages the
new immutable release without deletion, and changes `current` only during the
finalizer. A pre-commit failure restores and verifies the snapshot. A committed
publication writes a durable exact-byte receipt and remains locked until a
separate acknowledgement verifies the release, legacy files, pointer, and
receipt. Transport uncertainty therefore stops promotion for reconciliation;
it never triggers unverified cleanup or overwrite.

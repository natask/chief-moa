# Manual QA Checklist

## Overlay Voice

- Install the debug APK.
- Launch Moa and grant overlay permission.
- Grant microphone permission.
- Start the assistant circle.
- Start it again from the app, assistant entry point, and quick tile.
- Confirm every invocation reuses the same single orb instead of adding another
  overlay instance.
- Confirm the default orb is about 67dp (70% of the 96dp base) and remains
  readable at 30% idle opacity.
- Change Orb size in the full app while the overlay is running.
- Confirm the existing orb resizes immediately and remains inside the display.
- Confirm voice-first gestures are enabled.
- Single-click the idle companion and confirm current-thread capture starts.
- Confirm no X/Send controls appear and the companion does not shift horizontally.
- Single-click again and confirm the turn stops and sends exactly once.
- Double-click the idle companion and confirm fresh-thread capture starts.
- Confirm a single click does not send that fresh-thread draft, then double-click
  again and confirm it sends exactly once.
- Start another draft, triple-click, and confirm capture cancels without sending
  before chat opens.
- Press and hold the orb, drag it to a new spot, and release.
- Confirm capture cancels without sending and the compact overlay moves without
  opening a second surface.
- Confirm hold-drag and drag-to-remove still work at the smaller default size
  and after changing the size.
- Press and hold the still orb, speak a short request, and release.
- Confirm release submits the turn without waiting for extra silence.
- With TalkBack enabled, start a reviewable draft and focus the companion.
- Confirm `Send voice draft` and `Discard voice draft` are independent actions;
  invoke each in a separate draft and confirm it runs exactly once.
- Disable voice-first gestures and confirm legacy single-tap chat plus
  double-click-and-hold push-to-talk still work.
- Confirm the transcript appears in the overlay/panel history.
- Confirm the assistant answer appears as text.
- Confirm `Play spoken replies` is off by default.
- Repeat a voice turn and confirm no local TTS/audio playback occurs while text still appears.
- Enable `Play spoken replies`.
- Repeat a voice turn and confirm playback occurs.

## Agent Run Status

- Say or type an agent request such as `fix the small issue`.
- Confirm the gateway starts the run without blocking the phone.
- Confirm the overlay header shows an active run count.
- Wait for terminal state.
- Confirm the overlay appends a concise completion/failure/canceled message.
- Double-click and hold the orb while a run is active.
- Speak a follow-up.
- Confirm the follow-up is sent to the active agent thread and creates a tracked continuation run.

## Concurrent Sessions

- Start one agent run.
- Before it completes, start a separate normal voice question.
- Confirm the gateway stores the new turn separately and the app remains usable.
- Start another branch/session from voice and confirm existing run status is still visible.

## Wake Restart

- Stop the overlay from the full app.
- Start it again from the full app.
- Confirm the orb appears.
- Lock/unlock the phone if available.
- Confirm the foreground overlay service remains available or can be restarted from the app.

## AirPods / Headset Assistant Gesture

- Reinstall the APK.
- Clear any prior Android voice-command default for the headset/assistant chooser.
- Trigger the earbud/headset assistant gesture.
- Select Moa if Android shows a chooser.
- Confirm Moa starts the overlay voice flow.
- Speak a short request.
- Confirm transcript capture starts and the turn can be submitted.

## Device-Local Media And Saved Spots

- In the full app, choose the preferred installed YouTube variant and enable
  Notification access; confirm Moa does not claim either setting was granted silently.
- Confirm the fresh/default `YouTube` alias selects the installed
  Advanced/ReVanced app. Explicitly say `stock YouTube` for one request and
  confirm the override does not replace that default.
- Through typed chat, `POST /v1/voice/turns`, cascaded voice, and the configured
  Android legacy-Live mode, ask Moa to list visible apps and open one by its
  displayed label. Confirm each path uses the same bounded `app.list`/`app.launch`
  claim and terminal receipt loop.
- Try a duplicate visible label and a raw package/component-shaped value; confirm
  no app opens. Confirm `app.list` exposes bounded visible labels rather than
  granting package or hidden-component authority.
- From another foreground app, ask Moa to open the preferred YouTube app, search
  for a known exact title/channel, play it, pause/resume it, and seek back ten
  seconds; confirm each action has the intended package/media identity and a
  local receipt. Repeat a duplicate-title search without a channel and confirm
  no result is selected.
- Override the preferred variant for one request, then confirm the saved default
  did not change. Repeat with an unsupported/drifted variant and confirm it fails
  closed without tapping or seeking.
- On a known video, say "remember this spot as media QA," approve the disclosed
  video id/position/label, and confirm a title-only or invalid-id attempt is refused.
- Save two spots with partially overlapping names. Recall one with an exact
  label and one with a natural transcribed phrase; confirm deterministic
  exact/phrase/token matching and that an equal best match asks for a clearer
  name. Confirm no raw audio sample is stored or used as the matcher.
- From the browser extension, recall `media QA` and confirm it opens the same
  canonical video id near the saved timestamp without OAuth, cookies, or CDP.
  Then ask it to search for a bounded query with an exact title/channel; confirm
  it opens only one exact result and refuses zero or duplicate matches.
- Interrupt the network after a local tool effect and after an approved bookmark
  delete. Restart the surface, restore the network, and confirm the same
  claim-bound receipt is retried without repeating the effect and the deleted
  bookmark does not reappear while its tombstone is pending.
- Capture the preferred variant fixture in the full app, then on disposable
  playlists approve add, remove, create, rename, and delete in turn. Confirm
  success only after the exact membership/name/absence postcondition is visible.
  Change the foreground package, app version/signer fixture, UI-profile evidence,
  active window, or current media during another operation and confirm it stops
  with a stale/drift receipt instead of guessing.

## Overlay Parity

- With another app foreground, drag the anchored group once from the orb and
  once from the chat/voice header; confirm the card stays wholly above or below
  the orb with a gap.
- Triple-click to cancel an active draft, close the card while keeping the orb,
  then Hide or drag to Remove and confirm every overlay window disappears without
  opening the full app.
- Long-press and copy transcript text without moving the row. Clear selection,
  then confirm left and right swipes dismiss the same eligible row cascade.

## Android OTA Publication Safety

- In an isolated fake or preview OTA store with an existing current release,
  publish a new candidate and confirm the previous immutable release and verified
  snapshot remain available after the `current` pointer changes.
- Inject failures before upload, during finalization, after the durable publish
  receipt, and during acknowledgement. Confirm pre-commit failures restore the
  exact prior pointer/manifest/APK, while uncertain committed state remains
  locked with evidence for reconciliation and is never overwritten.
- Retry the exact committed operation and confirm acknowledgement verifies exact
  bytes before lock/staging cleanup. Try the same release id with different bytes
  and confirm publication fails closed.

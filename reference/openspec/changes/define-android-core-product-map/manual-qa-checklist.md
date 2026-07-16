# Manual QA Checklist

## Native Black UI + Family Fade (PENDING live screenshot QA)

Status 2026-07-16: implemented and unit-verified on branch
`worktree-moa-native-black-ui`; no Android device was attached, so live
screenshot QA is PENDING. Design was validated against the existing
screenshots in `scratch/mobile-ui-enhance/screens/` and
`scratch/agent-loop/moa-mobile-current-20260714.png` (green-glass baseline).

- Install the debug APK and start the overlay.
- Open the chat panel and confirm the card is opaque true black (no underlying
  app content bleeding through, no green cast), with hairline borders.
- Start a voice turn and confirm the transcript card is the same native black.
- With the panel or transcript open, tap the wallpaper/another app: confirm the
  lion orb + panel + transcript all fade in place and nothing closes; composer
  draft text, chat messages, transcript rows, and a playing reply survive.
- Touch any faded surface (lion, panel, or transcript): confirm the whole
  family returns to full opacity and that touch does NOT press a button, start
  a voice gesture, or swipe a row.
- Tap the lion again after the wake touch: confirm normal gestures work.
- With only the lion visible, tap elsewhere: confirm the lion alone fades and a
  touch on it restores full opacity without starting talk.
- While typing in the composer, confirm keystrokes on the keyboard do not fade
  the family.
- Capture screenshots of: black panel, black transcript, faded family, restored
  family; store them under `scratch/mobile-ui-enhance/screens/`.
- Press Start assistant circle: confirm the lion appears centered under the
  finger's release point, not at the default right-edge slot.
- Press Start near a screen corner: confirm the lion clamps fully on screen.
- With the overlay already running, press Start again: confirm the existing
  lion moves under the finger without the service restarting or surfaces
  closing.
- Activate Start via TalkBack or a keyboard: confirm the lion appears centered
  on the Start button itself.
- Open the chat panel, focus the composer, type on the keyboard: confirm
  keystrokes never fade the family and never hide the keyboard.
- Dismiss the keyboard (back/IME down), then tap outside: confirm the family
  fades again.
- With the keyboard up, tap the app underneath: confirm the keyboard hides
  (window focus moved) and a following outside tap parks the family.

## Overlay Voice

- Install the debug APK.
- Launch Moa and grant overlay permission.
- Grant microphone permission.
- Start the assistant circle.
- Single tap the orb.
- Confirm the chat menu opens for typed input.
- Press and hold the orb, drag it to a new spot, and release.
- Confirm the orb moves without opening the transcript overlay or chat menu.
- Double-click and hold the orb, speak a short request, and release.
- Confirm release submits the turn without waiting for extra silence.
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
- Cancel an active draft from the overlay, close the card while keeping the orb,
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

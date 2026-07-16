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
- Open the full app: confirm the settings cards are literal true black with
  hairline borders (no gray or green-tinted card fill), and chat bubbles in the
  overlay still read one step lighter than their card.
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
- With the panel (or transcript) open, press Start at a new spot: confirm the
  open surface moves with the lion and the composer draft/transcript rows
  survive the move.
- On an API 26-29 device (or emulator): keyboard up, press Back, then tap
  outside — confirm the family parks (the pre-30 dismissal signals work).
- On API 26-29 only: dismissing via the keyboard's own hide button is not
  observable; confirm the family simply stays bright (never wrongly fades or
  hides the keyboard) until the next tap/focus signal.

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

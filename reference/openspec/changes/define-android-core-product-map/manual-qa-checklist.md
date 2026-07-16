# Manual QA Checklist

## Overlay Voice

- Install the debug APK.
- Launch Moa and grant overlay permission.
- Grant microphone permission.
- Disable `voice_first_gestures` for the legacy checks in this section.
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

## Voice-First Native Overlay

- Enable `voice_first_gestures` and use Android's dark theme.
- Start an idle tap draft.
- Confirm Close/Cancel, Send, the grab affordance, and the removal target use
  crisp native dark controls with consistent icon sizing, readable contrast,
  native pressed feedback, and accessibility labels.
- Confirm another orb tap does not send the ordinary tap-started draft; only
  Send commits it and Cancel discards it.

## Agent Run Status

- Say or type an agent request such as `fix the small issue`.
- Confirm the gateway starts the run without blocking the phone.
- Confirm the overlay header shows an active run count.
- Wait for terminal state.
- Confirm the overlay appends a concise completion/failure/canceled message.
- Disable `voice_first_gestures` for the legacy active-thread follow-up check.
- Double-click and hold the orb while a run is active.
- Speak a follow-up.
- Confirm the follow-up is sent to the active agent thread and creates a tracked continuation run.

## Concurrent Sessions

- Start one agent run.
- Before it completes, start a separate normal voice question.
- Confirm the gateway stores the new turn separately and the app remains usable.
- Start another branch/session from voice and confirm existing run status is still visible.
- Leave a prior response visible, then double-click the orb.
- Confirm a distinct voice session and fresh branch start while the prior
  message remains visible and unchanged and the prior active run is not
  canceled.
- Single-click once while the new session is capturing.
- Confirm only the double-click-started capture ends and submits exactly once,
  no additional session starts, and the prior message remains visible.

## Overlay Layout And Dismissal

- Generate short, multiline, and image-bearing messages, open typed input, and
  drag the orb around the display.
- Confirm every content surface remains wholly above the orb/grab line with a
  visible gap and never covers or crosses the line.
- With a message and draft controls visible, drag the orb into the bottom
  removal target and release.
- Confirm capture/playback stops and the orb, cards, composer, controls, grab
  line, status, and removal target all disappear.
- Switch apps and confirm no orphan overlay window remains.

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

# Manual QA Checklist

## Overlay Voice

- Install the debug APK.
- Launch Moa and grant overlay permission.
- Grant microphone permission.
- Start the assistant circle.
- Double-press and hold the orb, speak a short request, and release.
- Confirm release submits the turn without waiting for extra silence.
- Confirm the transcript appears in the overlay/panel history.
- Long press the orb, speak a short request, and release.
- Confirm release submits the turn without waiting for extra silence.
- Confirm the transcript appears in the overlay/panel history.
- Single tap the orb.
- Confirm the transcript overlay appears.
- Speak a short question.
- Single tap while recording to submit.
- Confirm the transcript appears in the overlay/panel history.
- Confirm the assistant answer appears as text.
- Confirm `Play spoken replies` is off by default.
- Repeat a voice turn and confirm no local TTS/audio playback occurs while text still appears.
- Enable `Play spoken replies`.
- Repeat a voice turn and confirm playback occurs.
- Single tap while listening or playing and confirm capture/playback stops.

## Agent Run Status

- Say or type an agent request such as `fix the small issue`.
- Confirm the gateway starts the run without blocking the phone.
- Confirm the overlay header shows an active run count.
- Wait for terminal state.
- Confirm the overlay appends a concise completion/failure/canceled message.
- Long press the orb while a run is active.
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

# Voice Agent Router Plan

## Intent

Moa should feel like a voice layer over the phone and home-machine agents, not
like a chat app that happens to use a microphone. The user should be able to
start speaking quickly, see the transcript while speaking, send the full spoken
turn, and dispatch work to one or more agents without being talked over.

## Interaction Model

The floating assistant orb is the main control.

- Idle single tap: begin speech capture.
- Listening single tap: submit the current transcript and immediately start
  another speech loop.
- Double tap: stop current listening and TTS output silently.
- Long press: open or minimize the chat panel.
- Drag: move the orb without triggering voice capture.

This keeps the most common action on a single tap and reserves double tap for
the explicit interruption path.

## Transcript Overlay

The app should show live speech text as a small overlay similar to the Google
and Gemini screenshots in `gemini_images`.

The transcript overlay should:

- Appear while command speech is active.
- Update with partial recognition results.
- Avoid opening the full chat panel just to show recognition text.
- Disappear after the turn is submitted or stopped.
- Stay above the current app, near the bottom of the screen.

## Stop Behavior

`stop` is a control word, not a prompt.

When the user says `stop`, double taps the orb, or presses a stop control:

- Stop Android speech recognition if active.
- Stop Android TextToSpeech if active.
- Do not send `stop` to the model as a normal prompt.
- Do not speak a confirmation such as "okay, I stopped."
- If passive wake mode is enabled, resume passive listening quietly after a
  short delay.

## Speech Completeness

Voice-originated messages should send the full recognized turn. The Android
client should prefer final `SpeechRecognizer` results, keep the best live
partial transcript as a fallback, and use longer silence windows so the
recognizer does not cut the user off too aggressively.

## Agent Router

The server should own routing. The phone should capture intent and context;
the gateway should decide where work goes.

Near-term routing:

- `chat`: answer briefly in the Android overlay.
- `agent_run`: launch one home-machine agent harness.
- `multi_agent`: create several agent runs and combine short status updates.
- `control`: stop, mute, resume, branch, or change session.

Longer-term routing:

- Keep a long-context controller model on the server.
- Store operation history separately from spoken chat history.
- Associate audio, transcript, screen context, agent runs, and branch IDs with
  one session record.
- Let the controller route to Codex, Gemini, Claude, OpenCode, local models, or
  specialized agents.

## Data Model Direction

Each spoken turn should become a durable event:

```json
{
  "session_id": "mobile-session-id",
  "branch_id": "default",
  "turn_id": "turn-id",
  "source": "android-overlay",
  "audio_path": "optional/server/path.wav",
  "transcript": "full recognized text",
  "router_action": "chat|agent_run|multi_agent|control",
  "agent_run_ids": [],
  "created_at": "iso timestamp"
}
```

Android `SpeechRecognizer` does not expose raw audio reliably. If audio capture
must be saved for investigation, the app should add a parallel `AudioRecord` or
`MediaRecorder` capture path and upload the audio to the gateway with the final
transcript.

## Current Code Fit

Already present:

- Android overlay permission and floating orb.
- Native speech recognition.
- TextToSpeech replies.
- Gateway chat endpoint.
- Agent-run endpoint.
- Gateway voice-router endpoint at `/v1/voice/turns`.
- Compact voice-turn storage under `DATA_DIR/voice-turns`.
- Separate `speak` and `display` response fields for mobile-safe TTS.
- Local conversation history.

Missing or next:

- Raw audio upload.
- Branching sessions.
- Agent cancellation endpoint.
- Agent-run polling/status UI on Android.
- Stronger redaction for accessibility snapshots before long-term storage.

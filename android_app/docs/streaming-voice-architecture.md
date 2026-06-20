# Streaming Voice Architecture

## Goal

Prove the basic phone-to-server voice loop before expanding the assistant platform:

```text
tap overlay
  -> Android records microphone audio
  -> Android streams audio frames to Moa Gateway at 10.147.17.10
  -> user taps send
  -> Android commits the turn
  -> gateway transcribes/responds/synthesizes
  -> gateway streams audio back
  -> Android plays the assistant audio
```

This replaces passive wake-word behavior. Voice starts only from an explicit UI action.

## First Working Slice

The first software draft should prove transport and playback, not model quality.

1. Android captures PCM16 mono audio with `AudioRecord`.
2. Android opens `ws://10.147.17.10:8787/v1/voice/sessions`.
3. Android sends JSON control events and binary audio chunks.
4. Gateway writes received audio chunks to a turn file.
5. User taps send; Android sends `commit_turn`.
6. Gateway returns a fake transcript and streams a known test audio payload.
7. Android plays returned audio with `AudioTrack`.

Real STT, LLM, and TTS plug in after the transport loop is stable.

## User-Facing Flow

The UI should make the voice loop explicit:

```text
Idle
  orb says: Ask Moa
  tap orb or mic

Recording
  orb animates
  transcript area says: Listening...
  primary button says: Send
  secondary action says: Cancel

Sending
  audio capture stops
  WebSocket sends commit_turn
  transcript area shows final/fake transcript

Responding
  assistant text appears
  returned audio begins playing
  stop button interrupts playback

Done
  UI returns to idle
```

No passive trigger, no background wake word, no hidden listening state.

## State Machine

```text
IDLE
  start_pressed -> CONNECTING

CONNECTING
  socket_ready -> RECORDING
  socket_error -> ERROR

RECORDING
  audio_chunk -> RECORDING
  send_pressed -> COMMITTING
  cancel_pressed -> CANCELED
  socket_error -> ERROR

COMMITTING
  transcript_final -> WAITING_FOR_RESPONSE
  assistant_audio_start -> PLAYING_RESPONSE
  error -> ERROR

WAITING_FOR_RESPONSE
  assistant_audio_start -> PLAYING_RESPONSE
  assistant_text -> WAITING_FOR_RESPONSE
  turn_done -> DONE

PLAYING_RESPONSE
  assistant_audio_chunk -> PLAYING_RESPONSE
  assistant_audio_done -> DONE
  stop_pressed -> DONE

DONE
  reset -> IDLE

ERROR
  reset -> IDLE
```

This state machine belongs in `VoiceSessionController`; UI should render it, not invent independent voice state.

## Component Boundaries

### Android

`OverlayService`
: Owns Android foreground service and overlay lifetime only.

`OverlayUiController`
: Builds orb, transcript text, send button, status chips, and chat panel. This can remain partly inside `OverlayService` until the streaming loop works.

`VoiceSessionController`
: Owns one active voice interaction. Creates a session id, starts/stops capture, sends commit/cancel, and tracks UI state.

`AudioCaptureController`
: Wraps `AudioRecord`. Emits PCM16 mono chunks. Does not know about gateway protocol or UI.

`VoiceGatewaySocket`
: Owns the WebSocket. Sends control JSON and audio binary frames. Receives transcript events and audio chunks.

`AudioPlaybackController`
: Wraps `AudioTrack`. Buffers and plays assistant audio chunks. Owns stop/interruption.

`ContextProvider`
: Reads Android screen context through accessibility. Read-only.

`ActionExecutor`
: Performs local Android actions after local approval. Not part of the first voice-loop slice.

### Gateway

`VoiceSessionServer`
: WebSocket endpoint at `/v1/voice/sessions`.

`AudioSessionStore`
: Stores session metadata and raw PCM chunks under `DATA_DIR/voice-sessions`.

`TranscriptionService`
: First draft emits a fake transcript. Later adapters: Deepgram, OpenAI, faster-whisper.

`AssistantTurnRunner`
: First draft emits a canned text reply. Later calls model/router/agent runtime.

`TtsStreamer`
: First draft streams a test tone or existing WAV/PCM payload. Later adapters: OpenAI TTS, ElevenLabs, Piper.

## First Draft Software Map

The draft implementation should land in these places:

```text
software/android_app/app/src/main/java/ai/moa/assistant/
  MoaAudioCaptureController.java
  MoaAudioPlaybackController.java
  MoaVoiceGatewaySocket.java
  MoaStreamingVoiceSessionController.java

software/moa_gateway/
  server.js
  lib/voice-session-server.js
```

The draft does not need to replace the existing `MoaVoiceController` immediately. It can be built side-by-side so the current overlay remains installable while the streaming path becomes testable.

## Wire Protocol

Use one WebSocket per active voice session.

Text messages are UTF-8 JSON:

```json
{
  "type": "session_start",
  "session_id": "mobile-session-id",
  "turn_id": "turn_uuid",
  "format": {
    "encoding": "pcm16",
    "sample_rate": 16000,
    "channels": 1
  },
  "source": "android-overlay"
}
```

```json
{
  "type": "commit_turn",
  "turn_id": "turn_uuid"
}
```

```json
{
  "type": "cancel_turn",
  "turn_id": "turn_uuid"
}
```

Binary messages from Android are raw PCM16 little-endian audio frames for the current turn. The server counts sequence numbers internally for the first draft. If we need loss detection later, binary frames can gain a small header.

Server text events:

```json
{
  "type": "session_ready",
  "session_id": "mobile-session-id"
}
```

```json
{
  "type": "transcript_partial",
  "turn_id": "turn_uuid",
  "text": "partial text"
}
```

```json
{
  "type": "transcript_final",
  "turn_id": "turn_uuid",
  "text": "final transcript"
}
```

```json
{
  "type": "assistant_text",
  "turn_id": "turn_uuid",
  "text": "Short reply."
}
```

```json
{
  "type": "assistant_audio_start",
  "turn_id": "turn_uuid",
  "format": {
    "encoding": "pcm16",
    "sample_rate": 16000,
    "channels": 1
  }
}
```

Binary messages from gateway after `assistant_audio_start` are raw PCM16 assistant audio chunks.

```json
{
  "type": "assistant_audio_done",
  "turn_id": "turn_uuid"
}
```

```json
{
  "type": "turn_done",
  "turn_id": "turn_uuid",
  "status": "completed"
}
```

```json
{
  "type": "error",
  "message": "human-readable error"
}
```

## Provider Choices

Transport:
- MVP: OkHttp WebSocket on Android plus Node `ws` on gateway.
- Later: LiveKit if we need WebRTC reliability, reconnects, media tracks, and production-grade audio transport.

STT:
- MVP: fake transcript, then commit-time transcription.
- Fast external path: Deepgram streaming.
- Self-host path: faster-whisper, likely commit-time first.

TTS:
- MVP: generated test tone or static PCM.
- Fast external path: OpenAI or ElevenLabs streaming TTS.
- Self-host path: Piper or another local TTS engine.

## Failure Handling

For the MVP, failures should be visible and boring:

- WebSocket connection fails: show "Cannot reach gateway at 10.147.17.10".
- Audio permission missing: open the setup screen or show the existing permission message.
- Commit fails: stop recording, keep local error visible, allow retry from idle.
- Playback fails: show text response and mark audio failed.
- Gateway receives binary audio before `session_start`: close with an error event.
- Gateway receives `commit_turn` without audio: still return a fake transcript for testability, but mark metadata with `empty_audio: true`.

Do not silently fall back to Android `SpeechRecognizer` inside the streaming flow. That would hide transport bugs.

## Critique Of The Architecture

The risky part is not the overlay. The risky part is audio state: capture, send, commit, playback, interruption, and reconnection. Keep those as separate controllers.

The second risk is trying to ship live transcription and LLM response in the same first slice. The first slice should prove that phone audio reaches the server and server audio plays back.

The third risk is allowing server actions to bypass Android policy. Server responses can propose actions later, but Android remains the execution authority.

## Open Questions

- Should the MVP use cleartext `ws://` over ZeroTier or `wss://` with local certs? First draft can use `ws://10.147.17.10:8787`.
- Should assistant audio be raw PCM16 or WAV-framed chunks? First draft should use PCM16 after an `assistant_audio_start` format event.
- Should the Android UI have one active voice session or multiple cards immediately? First draft should use one active session and preserve the protocol shape for multiple sessions.

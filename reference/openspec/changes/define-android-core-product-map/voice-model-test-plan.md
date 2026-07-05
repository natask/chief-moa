# Voice Model Test Plan

This plan verifies the Moa voice loop across the Android app, gateway, and
streaming model provider. It is written for the current Android-first product
map and should be run before choosing a final speech-to-speech provider.

## Current Working Baseline

- Gateway: `http://10.147.17.6:8787`
- Voice WebSocket: `ws://10.147.17.6:8787/v1/voice/sessions`
- Current verified provider: `vertex-live`
- Current verified Live model: `gemini-live-2.5-flash-native-audio`
- Text/agent model: `gemini-3.5-flash`
- Known blocked path: `vertex-live` with `gemini-3.1-flash-live-preview`
  rejected the model ID in the current Vertex project/location.
- Candidate 3.1 path: `gemini-live` with `GEMINI_API_KEY` and
  `GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview`.

Do not print `.env` while testing. Check only whether required keys are set.

## Fast Gateway Checks

Run these from the repo root.

```bash
cd gateway
npm run check
curl -s http://10.147.17.6:8787/health
```

Pass criteria:

- `npm run check` exits `0`.
- Health returns `ok: true`.
- `voice_stream.provider.configured` is `true`.
- `voice_stream.provider.model` is the model you intended to test.

## WebSocket Voice Smoke

This verifies gateway-to-provider streaming without the phone.

```bash
node gateway/deploy/main-machine/smoke-voice-session.js \
  ws://10.147.17.6:8787/v1/voice/sessions
```

Pass criteria:

- Emits `session_ready`.
- Emits `transcript_final`.
- Emits `assistant_text`.
- Emits `assistant_audio_start`.
- Receives non-zero binary assistant audio bytes.
- Emits `assistant_audio_done`.
- Emits `turn_done`.

Failure interpretation:

- `session_ready` only, then provider error: model/auth/region issue.
- No binary audio: model responded with text only or audio output config failed.
- Missing `turn_done`: provider never sent a terminal event or gateway timeout
  handling needs work.

## Provider Matrix

Test one provider at a time. Restart the gateway between rows.

| Provider | Required env shape | Expected result |
|---|---|---|
| `vertex-live` + `gemini-live-2.5-flash-native-audio` | Vertex ADC or `VERTEX_EXPRESS_API_KEY` | Should pass today |
| `vertex-live` + `gemini-3.1-flash-live-preview` | Vertex ADC or `VERTEX_EXPRESS_API_KEY` | Expected fail in current project/location |
| `gemini-live` + `gemini-3.1-flash-live-preview` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Candidate path to test |
| `openai-realtime` + `gpt-realtime-2` | OpenAI API key and gateway adapter | Future candidate |
| Deepgram Voice Agent | Deepgram key and gateway adapter | Future pipeline candidate |

For each provider, record:

- Model ID accepted by provider.
- Time from commit to first transcript.
- Time from commit to first assistant audio.
- Whether user transcript is partial, final, or fallback only.
- Whether assistant text is available while audio streams.
- Whether the gateway can mute audio while keeping text.
- Whether programmatic cancel stops playback and provider work.
- Whether voice barge-in interrupts assistant speech.

## Android Manual QA

Install and launch:

```bash
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.moa.assistant/.MainActivity
```

Permissions:

```bash
adb shell pm grant ai.moa.assistant android.permission.RECORD_AUDIO
adb shell appops set ai.moa.assistant SYSTEM_ALERT_WINDOW allow
```

Manual tests:

1. Open the app and confirm gateway health is reachable.
2. Confirm `Play spoken replies` is off by default for a fresh install.
3. Start overlay voice from the app button.
4. Speak a short request: "What can you hear right now?"
5. Confirm user transcript appears in the overlay.
6. Confirm assistant response appears as text.
7. Confirm no audio plays when spoken replies are disabled.
8. Enable spoken replies and repeat.
9. Confirm assistant audio plays only when enabled.
10. While assistant is responding, tap stop.
11. Confirm playback stops and overlay remains usable.
12. Start another voice turn while a prior agent run is active.
13. Confirm it creates a separate session/turn and does not merge in memory.

## Barge-In Test

Use spoken replies enabled.

1. Ask for a long response: "Explain the current project architecture in detail."
2. While the assistant is speaking, say: "Stop. New question."
3. Expected:
   - Android stops local playback quickly.
   - Gateway/provider emits or infers interruption.
   - New user transcript is captured.
   - The new turn is stored separately.

If the model cannot handle provider-native barge-in, Android must still provide
programmatic stop by halting playback and canceling or replacing the turn.

## Transcript And Audio Policy Test

For each provider, verify the UI can choose independently:

- Show user transcript: yes/no.
- Show assistant transcript: yes/no.
- Play assistant audio: yes/no.
- Store raw provider audio: no by default, except explicit QA artifacts.
- Store transcript/session/run metadata: yes.

Pass criteria:

- Turning audio off does not disable transcript display.
- Assistant text can be shown even when audio is discarded.
- Android never stores provider API keys.
- Gateway stores provider credentials only on the gateway machine.

## Final Provider Decision Rule

Choose the provider that passes the core UX checks first, not the one with the
best model name:

1. Reliable start from Android button and assistant/voice-command entry.
2. Low-latency transcript visibility.
3. Clean programmatic stop.
4. Good voice barge-in.
5. Assistant text and audio both available so UI can decide what to render.
6. Tool/action proposals are structured and inert until Android approves them.
7. Runs and sessions persist to the gateway store.

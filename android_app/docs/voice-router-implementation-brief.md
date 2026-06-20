# Voice Router Implementation Brief

## Cleaned Thought

Moa should be a phone-level voice control surface for local and home-machine
agents. The Android app should capture speech quickly, show the transcript while
the user is talking, and send a completed turn to the server. The server should
decide whether the turn is chat, control, one agent run, or multiple agent runs.

The user should not have to think about which backend agent to use. The phone
should stay lightweight; the gateway should own routing, session history, and
agent run records.

## Product Rules

- The orb is the primary control.
- Stop is local and silent.
- Agent work should start asynchronously and keep working unless explicitly
  stopped later.
- The assistant should say little. TTS text must be short and separate from the
  display text.
- Voice turns should be saved as durable events associated with a session,
  branch, transcript, screen context summary, and downstream run IDs.

## Next Slice

Add a gateway endpoint:

```text
POST /v1/voice/turns
```

It should:

- Accept a final transcript, session/conversation ID, branch ID, optional
  client intent hint, recent messages, and screen context.
- Classify the turn with deterministic rules first.
- Bias toward `chat`; only run agents on explicit or very clear agent-work
  phrases.
- Store a compact voice-turn record.
- Delegate chat turns to the existing model path.
- Delegate agent turns to the existing agent-run path.
- Return immediately for agent work with a run ID instead of blocking the phone.

## Response Contract

```json
{
  "turn_id": "turn_...",
  "session_id": "mobile-session",
  "conversation_id": "conversation",
  "branch_id": "default",
  "classification": "chat|agent_run|multi_agent|control",
  "speak": "Short TTS-safe text.",
  "display": "Overlay-safe status or answer.",
  "text": "Compatibility alias for display or speak.",
  "actions": [],
  "agent_run": null,
  "agent_runs": [],
  "follow_up_expected": false,
  "end_of_turn": true
}
```

## Gemini/Claude Agreement

The independent consultation agreed on:

- Add `/v1/voice/turns` now.
- Make it a thin router over existing chat and agent endpoints.
- Keep classification heuristic before using a model-router.
- Add idempotent `turn_id` to avoid duplicate agent runs.
- Keep agent runs async.
- Split `speak` from `display`.
- Avoid storing full raw accessibility dumps in the voice-turn log.


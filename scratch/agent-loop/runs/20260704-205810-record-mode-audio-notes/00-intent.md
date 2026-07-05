# Intent: record mode (raw audio notes)

## Raw user goal (2026-07-04 session)

The user started asking for an OpenSpec plan to make the DigitalOcean deployed
version operational, then superseded it in the same message: "Actually, instead
of doing that, I wanted to be able to capture what I'm saying."

The feature, in the user's own nouns:

- "I press a button and I speak."
- A mode: "this is X mode ... the record mode is just me speaking."
- "That's what I've said that gets captured and stored."
- "We're not doing any transcription. We're just going to be storing it
  directly. The audio is going to be stored simply."
- Purpose: "take that and evaluate it to improve it. It's going to be a
  note-taking of sorts." Embedded into the application.
- "Don't stop until this is done ... burn as many credits as possible."

Follow-up message: use as many agents as needed, codex may run as a sub-agent,
and codex-as-subagent should become an invocable skill.

## Success in observable terms

1. From a client surface (browser extension and/or Android orb), the user can
   enter record mode, speak, and end the recording.
2. The gateway stores the raw audio as a durable "audio note" record: playable
   bytes on disk/blob store + a queryable record (id, timestamps, duration,
   source surface, session).
3. No STT, no LLM call, no TTS runs for a record-mode capture.
4. Notes are listable and fetchable (audio playable back) via gateway API.
5. Verification: gateway `npm run check` + a deterministic smoke that stores a
   fake PCM note and reads it back; extension `npm run verify && npm run smoke`;
   Android `assembleDebug` if the Android lane lands.

## Explicitly not wanted

- Transcription of any kind (STT) on the capture path.
- A DigitalOcean deployment work stream (superseded in the same message).
- Blocking on chat-memory; plan must live in OpenSpec + run artifacts.

## Target repo / subsystems

`chief-moa`: `gateway/` (storage + API), `browser_extension/` (capture UI),
`android_app/` (capture UI, secondary). Live gateway freeze applies: implement
in an isolated worktree/branch; promotion to the live gateway stays gated on
explicit user approval.

## Current uncertainty

- Which client surface first (browser extension vs Android) — resolve to both
  lanes if capacity allows; browser extension is the fastest verifiable loop.
- Exact reuse point: the WS voice-session archive already stores raw PCM; record
  mode may ride the same transport with a `mode: note` flag vs a new simpler
  HTTP upload endpoint. Explorer reports will decide.

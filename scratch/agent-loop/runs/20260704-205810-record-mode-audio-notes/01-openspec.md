# OpenSpec: record mode (raw audio notes)

Repo OpenSpec change: `reference/openspec/changes/record-mode-audio-notes/`

## Problem

The user wants a note-taking mode: press a button, speak, and the spoken audio
is captured and stored directly. No transcription, no model call. The stored
notes exist to be evaluated and improved later. Today every voice path runs the
STT -> LLM -> TTS pipeline, so there is no way to just keep what was said.

## User-Control Boundary

Autonomous: OpenSpec authoring, worktree implementation, verification, commits,
extension packaging. Requires user approval: promoting the live gateway
(restart/redeploy), pushing to a remote, Android OTA publish to the live
gateway.

## Non-Goals

- STT/transcription of notes (explicitly excluded by the user).
- DigitalOcean deployment work (superseded in the same message).
- Note evaluation/improvement features (a later run).
- A full notes browser UI; list + playback via API is enough for this slice.

## Primitives

- intent artifact: `00-intent.md`
- critique artifact: `00-critique.md`
- ticket ledger: `scratch/agent-loop/tickets.tsv`
- wave executor: Fabro workflow + scoped sub-agents (codex authorized)
- verification evidence: `04-verification.md`
- feedback intake: `scratch/agent-loop/feedback.tsv`

## Acceptance Criteria

- `POST /v1/audio-notes` stores raw audio bytes durably under `DATA_DIR` with a
  queryable record (id, created_at, surface, session id, mime, size, duration
  hint) and appends an `audio_note.created` product event.
- `GET /v1/audio-notes` lists notes; `GET /v1/audio-notes/:id/audio` returns the
  exact stored bytes.
- The capture path never invokes STT, LLM, or TTS providers.
- Browser extension: a record-mode control captures mic audio and uploads it as
  a note; the UI shows recording state and a stored/failed receipt.
- Android: a record-mode control on the orb/chat surface captures and uploads a
  note (second wave; must not block the gateway+extension milestone).

## Verification

- Gateway: `cd gateway && npm run check` plus a new deterministic
  `npm run smoke:audio-notes` (POST synthetic bytes, read back byte-identical,
  list contains record; no network providers).
- Extension: `cd browser_extension && npm run verify && npm run smoke`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.

## Failure Modes

- Accidental provider invocation: prevented by a dedicated HTTP upload path
  that never touches the voice-session provider pipeline; smoke asserts no
  provider module is loaded on the notes path.
- Lost audio on upload failure: client keeps its local capture until the
  gateway confirms storage; failure surfaces a visible error.
- Live-gateway mutation: all work in an isolated worktree; deploy recorded as a
  gated blocker unless the user explicitly promotes.
- Android lane stall: waves ordered so gateway+extension complete alone.

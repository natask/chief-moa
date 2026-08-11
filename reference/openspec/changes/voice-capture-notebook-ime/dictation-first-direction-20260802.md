# Dictation-First Product Direction — 2026-08-02

Raw direction: "the dictation pipeline is the first we should complete across
all surfaces."

## Decision

Reliable literal dictation is milestone one. Browser automation, assistant
expansion, and richer generated UI do not define completion for this milestone.

"Across all surfaces" means every runnable product Surface uses the same
gateway transcription-only contract while retaining its own local authority:

- browser owns microphone capture, visible state, and clipboard delivery;
- Android launcher owns capture/clipboard fallback, and Android IME owns safe
  focused-editor insertion through `InputConnection`;
- native Mac owns its microphone, explicit dictation activity, clipboard, and
  receipts separately from assistant voice;
- gateway owns provider credentials, literal transcription, retained capture
  state, and queryable capture blocks;
- Windows remains explicitly missing until a runnable native shell exists.

No dictation completion may invoke reasoning, TTS, tools, browser actions,
Accessibility typing, or agent dispatch. Final text must remain copyable and
editable, recording state must stay visible, and retained audio/transcript
failure must be honest and retryable.

The browser enforces this at the worker's first inbound voice-event boundary.
Capture-only and transcript-finalizing sessions drop binary assistant audio and
assistant text, audio, media, tool, and action events before state, presentation,
or dispatch. Transcript and terminal events still pass after embedded assistant
or action payloads are removed. Ask behavior does not change.

Literal and Polished are separate copy variants. Polished calls a dedicated
authenticated gateway rewrite route with the exact source, request binding, and
fixed versioned 25-rule writing contract. The route loads no standing memory,
profile, conversation history, page context, tools, or actions and persists
nothing. The response binds back to the source digest and request id. A failure
leaves the literal variant unchanged and available.

## First Missing Observable Behavior

Android has launcher dictation but no real input method. The first implementation
unit is a voice-first `InputMethodService` that refuses sensitive editors, binds
the transcript to the editor session that started capture, and inserts only
through the active `InputConnection` after explicit user confirmation.

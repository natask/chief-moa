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

## First Missing Observable Behavior

Android has launcher dictation but no real input method. The first implementation
unit is a voice-first `InputMethodService` that refuses sensitive editors, binds
the transcript to the editor session that started capture, and inserts only
through the active `InputConnection` after explicit user confirmation.

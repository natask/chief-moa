# Voice Capture Notebook And Android IME

## Status

Partially implemented. Ask/Note/Coach delivery state, browser literal dictation,
worker-authoritative cross-tab state, and the additive capture-block projection
exist. The current candidate adds the first real Android voice IME: it blocks
sensitive editors, binds a transcript candidate to its originating editor, and
inserts only through `InputConnection` after an explicit Insert action. These
candidate changes are not a production promotion, and they do not complete the
Android notebook, audio-first capture lifecycle, IME language controls, native
Mac dictation activity, or physical-device acceptance described by this change.

## Why

Moa already captures streaming voice, stores canonical voice turns, stores raw
audio notes, supports multilingual provider profiles, and exposes a movable
Android orb. Those pieces do not yet form one daily note-taking product:

- record-mode audio notes intentionally skip transcription;
- voice-chat transcripts are conversation artifacts rather than editable note
  blocks;
- the full Android app has no notebook/library for captured speech;
- the app is not an Android input method and cannot reliably insert dictated
  text into the focused field;
- gesture-triggered agent runs and capture are not represented as separate user
  choices;
- the current task ledgers overlap and sometimes describe implemented work as
  pending, obscuring the shortest path to a usable product.

The primary outcome is a personal capture tool: press or hold, speak in English,
Amharic, or a configured language, stop, and immediately receive a durable audio
block plus copy-pastable text. The same capture primitive should later support
writing-style rewrites, writing drills, explicit agent dispatch, and voice
review without making any of those features prerequisites for reliable capture.

## Intent Order

1. Never lose spoken content.
2. Produce editable, copyable transcript blocks quickly.
3. Make repeated press/hold segments cheap and independent.
4. Keep mixed-language literal dictation explicitly available through the
   browser surface and immediately copyable for paste. One extension worker owns
   the active dictation session; tabs are interchangeable views of that state.
   The OS-wide double-Command gesture now belongs to the native Mac assistant.
5. Let the same speech insert into any focused Android text field through a real
   keyboard.
6. Apply user-selected writing skills without overwriting the literal transcript.
7. Launch one or more agents only when the user explicitly dispatches a block or
   selects an opt-in routing policy.
8. Add speaking/writing drills and richer media capture after the capture loop is
   dependable.

## What Changes

- Introduce a gateway-owned `capture_block` record that links retained audio,
  literal transcript, language evidence, revisions, source surface, timestamps,
  and optional dispatch records.
- As an additive first projection, turn each completed transcription-only
  browser turn into a queryable literal capture block and append one inert
  `file_only` / `unclassified` routing proposal. This proposal preserves the
  thought without invoking a model, selecting an intent, or launching an agent.
- Evolve Android record mode from storage-only audio into capture mode:
  upload safely, transcribe asynchronously, and show a copy/edit/share result.
- Add a notebook/library to the full Android app for browsing, replaying,
  copying, editing, retrying transcription, and deleting or exporting captures.
- Add a separate Android IME surface that records speech and commits the selected
  transcript or rewrite to the current `InputConnection`.
- Preserve the movable orb and add an explicit drag-to-dismiss target. Dismissal
  hides the overlay; it does not delete notes or stop the foreground service
  without an explicit second action.
- Represent each press/hold capture as its own block. A double-tap-and-hold may
  create a block and keep the capture tray open, but does not automatically
  launch an agent.
- Add explicit block actions: copy, insert, append to note, rewrite with a named
  writing skill, dispatch to one agent, dispatch as a chosen multi-agent job,
  and discard.
- Preserve literal transcripts and audio independently from derived rewrites,
  coaching feedback, summaries, or agent outputs.

## Product Modes

- **Capture:** store audio and transcript; no assistant reply and no agent.
- **Dictate:** capture, optionally rewrite, then insert into the focused field.
- **Ask:** send the transcript as a conversational turn and receive a response.
- **Dispatch:** start a visible agent run from one or more selected blocks.
- **Drill (later):** compare a spoken or written attempt with the user's own
  style corpus and return evidence-backed coaching.

Mode is explicit and visible. Silence, pauses, screen text, and model output do
not change it implicitly.

## Non-Goals For The First Slice

- No full custom Amharic key layout yet; the first IME may be voice-first with a
  small text/control row and a safe switch-keyboard affordance.
- No automatic agent launch per stopped recording.
- No video gesture or four-tap contract until single-block capture is proven on
  a physical phone.
- No grading of speaking quality in the capture path.
- No ads inside the keyboard or capture transcript surface. An IME handles
  highly sensitive input, so monetization must not depend on observing typed or
  dictated content.
- No destructive orb removal by drag alone.

## Success Criteria

- From the overlay, the user can create three separate spoken blocks in a row;
  each retains audio and reaches either `transcribed` or a visible retryable
  failure state.
- The literal transcript of every successful block is copyable and editable.
- English, Amharic, and mixed-language fixtures retain explicit configured
  language evidence and never silently mutate the global language profile.
- From the Moa IME, a user can hold to speak and commit the chosen text into a
  normal focused Android text field without accessibility-driven taps.
- Password and other configured sensitive fields do not record, upload, retain,
  rewrite, or display prior capture content.
- A writing-skill revision never destroys or silently replaces the literal
  transcript.
- Agent work begins only after an explicit dispatch and returns a visible run
  identifier and lifecycle state.

## Relationship To Existing Changes

- Extends `record-mode-audio-notes`; it does not replace its lossless raw-audio
  storage or no-provider storage guarantee at upload time.
- Reuses `provider-agnostic-voice-agent-runtime` STT/provider packages and
  canonical language state.
- Reuses `voice-first-orb-gestures` for capture entry but proposes a dedicated
  capture-mode gesture interpretation rather than adding more global tap chords.
- Reuses `define-android-core-product-map`: overlay remains capture, full app
  remains inspection, Android owns local UI/permissions/insertion, and the
  gateway owns provider routing and durable records.

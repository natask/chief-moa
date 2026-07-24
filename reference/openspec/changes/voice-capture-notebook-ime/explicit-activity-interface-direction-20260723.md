# Explicit Activity Interface Direction (2026-07-23)

## Decision

Replace hidden multi-tap mode selection with three visible activities:

| Activity | Entry | Result |
| --- | --- | --- |
| Speak | labeled mic/button | conversational turn in the current thread |
| Dictate | labeled button | literal transcript; no reasoning, TTS, or action |
| Type | labeled button/composer | editable text sent only by explicit Send |

Notebook is the durable history/destination, not another gesture mode. New
thread, Stop/Send, Cancel, Mute, Interrupt, Attach, and playback are visible
actions. Hold-to-talk may remain an accelerator on the visible mic.

## Drag Contract

Dragging the Android orb or browser mascot only repositions it. It never sends,
cancels, pauses, branches, mutes, or changes activity. If drag starts during a
hold-started capture, the capture becomes latched and keeps the same
session/turn identity after release. Explicit Stop/Send commits it and Cancel
discards it.

## Capture And History

- Remove the five-minute product limit by writing bounded durable chunks plus a
  manifest.
- Create a timestamped history row at capture start. Empty or failed transcripts
  remain visible with retained-audio and retry state.
- Keep `Retry transcript`, `Rewrite`, `Record again`, and `Play` distinct.
- Dictation replaces the clipboard and shows `Copied — clipboard replaced`.
- Add visible file/video attachment. Drag/drop is optional acceleration.

## Surface Notes

- Android keeps the low-alpha idle orb with a high-visibility accessibility
  option. Notebook depth stays in the full app. Cross-app files use Sharesheet
  and document picker before drag/drop.
- Browser uses the same labeled dock. Packaged extension UI always retains a
  trusted Stop control. It may copy dictation but cannot type into another app.
- macOS first replaces Wispr through global start/stop dictation, literal
  transcript, clipboard replacement, and a small history HUD. Direct insertion
  is a separate native authority feature.
- Technical recognition bias reuses the bounded `speaker_context`. A
  project-specific glossary waits for human-verified English, Amharic,
  code-switching, proper-noun, acronym, identifier, and false-positive tests.

## First Ticket

Make drag and active capture orthogonal on Android and browser.

Acceptance:

1. Start hold-to-talk.
2. Cross movement slop and reposition the control.
3. Capture/session identity remains unchanged; no cancel or commit is emitted.
4. Release leaves capture active.
5. Explicit Stop/Send commits once; Cancel discards once.
6. Idle drag starts no microphone.

The normative `voice-first-orb-gestures` contract currently requires movement
to cancel capture. Update that contract before implementing this ticket.

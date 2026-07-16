# Android Screen-Aware Ask and Literal Dictation Integration

## Candidate scope

This integration combines the exact reviewed screenshot history ending at
`4de52d15` and IME history ending at `cc149817` on base `46b2cbf8`. The only
merge conflict was their append-only Android done ledger; both entries were
preserved.

The overlay now exposes a distinct `Ask + screen` control. Its tap issues and
consumes one screenshot grant, refreshes semantic context after capture, and
sends the gateway-compatible optional screen-evidence envelope with explicit
`assistant_response` intent. Denied, secure, stale, or failed capture sends no
pixels and shows whether the Ask continued with semantic context or without
screen context. The Android chat client consumes only response text and does
not execute returned proposals.

The opt-in IME now exposes hold-to-dictate through Android
`SpeechRecognizer`. Partial and final literal candidates remain bound to the
ordinary editor generation. `Insert` is still a separate exact
`InputConnection.commitText(text, 1)` operation and performs no submit. A
sensitive or changed editor cancels capture and clears candidate state.

`SpeechRecognizer` does not expose replayable raw audio, so this MVP does not
claim a durable gateway capture block. The client boundary accepts only a real
stored audio-note id for a later raw-audio implementation; the IME does not call
it.

## Deterministic evidence

- `testDebugUnitTest`, focused IME coverage, focused screen-envelope coverage,
  and `assembleDebug` pass together.
- IME pure policy aggregate: 145/149 lines (97.3%), 127/136 branches (93.4%),
  and 26/27 methods (96.3%).
- Screen-evidence envelope: 51/51 lines (100%), 34/35 branches (97.1%), and
  7/7 methods (100%).
- The gateway capture-block boundary test requires an existing audio-note id
  and asserts the Android IME source; no SpeechRecognizer result is represented
  as durable audio.
- Strict OpenSpec validation passes. The candidate's API-26 screenshot/IME lint
  findings were fixed; repository `lintDebug` still stops on the unchanged
  `MoaQuickTileService` deprecated `startActivityAndCollapse(Intent)` call.

## Physical and integration blockers

No APK was installed or deployed in this ticket. Physical-phone acceptance is
therefore not measured: real screenshot allowed/denied/secure/stale behavior,
SpeechRecognizer English/Amharic/mixed quality, exact insertion in two ordinary
apps, sensitive-field suppression, and stale-focus refusal all remain open.
The deployed gateway must contain the exact route contract ending at
`f11e121f` (or a verified compatible successor) before screen-evidence or
capture-block runtime QA can pass.

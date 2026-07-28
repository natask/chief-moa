# Android assistant invocation routes

Acceptance: system assist, voice assist, voice command, launcher, overlay
notification, and assistant quick tile all reach the companion overlay and
request immediate recording. `MainActivity` remains limited to explicit
settings, control-center, update, history, and accessibility-setup routes.

The Android assistant role accepts an exported `ACTION_ASSIST` activity, so this
capture-only surface does not require a stateful `VoiceInteractionService`.
Defensively redirect an assist action delivered to `MainActivity` through the
same coordinator in case Android retains an older explicit component choice.

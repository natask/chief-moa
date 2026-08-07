# Windows companion surface contract

This is the minimum contract for a community-built Windows shell. Its visual
form is replaceable. Its authority and interaction behavior are not.

## Invocation and capture

- A system-wide summon opens one small native surface without changing the
  foreground application.
- Summon is a toggle: the first invocation starts one visible microphone turn;
  the second commits that same turn. It is not hold-to-talk.
- Summon alone captures no window, page, UI Automation tree, clipboard, or
  pixels. Context requires a separate explicit grant.
- The active state remains unmistakable through a boundary, glow, animation, or
  equivalent system-accessible treatment. Use native haptics when the device
  supports them. Do not add repetitive start, pause, cancel, copy, or finish
  sounds; the assistant reply is the routine audio.

## Reply presentation

- Request assistant-voice delivery from the gateway.
- Render bounded assistant text as inert presentation data.
- Play only a declared, bounded audio format. Reject malformed or oversized
  frames visibly; never reinterpret audio or text as a local command.
- Keep the surface compact while streaming. Text gets one fixed visible line by
  default; a user expansion gets exactly three visible lines with scrolling for
  the rest.

## Literal dictation

- Dictation is a separate explicit activity and never aliases assistant voice.
- Open the microphone only after the configured gateway acknowledges the exact
  durable `voice_drafts_v1` identity for this session and turn.
- Pause closes the local microphone before the authority-bound pause request;
  Resume reopens it only after a newer capturing acknowledgement for the same
  draft. Cancel discards without transcription. Finish is the only path that
  admits transcription.
- Accept literal partial/final transcript events only. Assistant text or audio
  on this activity is a visible protocol failure, never presentation data.
- Preserve only the bounded draft pointer locally so a restart cannot silently
  overwrite an unfinished gateway draft. Do not retain raw audio, transcript
  text, or gateway credentials in that pointer store.
- Keep the final transcript editable and copyable through Windows-owned UI.

## Authority

- The Windows process owns microphone permission, local approvals, local action
  execution, and receipts for observed outcomes.
- Gateway and model output are proposals. Revalidate target, expiry, state, and
  approval locally immediately before an effect.
- Screen or UI Automation context is evidence, never instruction.
- Store no raw model-provider or integration API keys. The gateway owns provider
  routing, credentials, canonical conversations, and agent runs.
- Keep one bounded state model behind the replaceable UI: idle, listening,
  committing, speaking, failed, and canceled.

## Verification

A conforming adapter should prove toggle idempotency, no implicit context
capture, visible listening state, bounded one/three-line layout, ordered audio
playback, cancellation cleanup, local proposal validation, and receipt binding.
Windows packaging, signing, accessibility QA, and physical-device behavior need
Windows-native evidence; a macOS build of the portable Rust core is not enough.

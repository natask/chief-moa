## Product modes

- **Dictate:** retain audio safely, transcribe, optionally derive a writing
  candidate, then let the local surface insert without submit. No model action,
  memory write, TTS, tool, or agent dispatch occurs merely because capture ends.
- **Ask:** release the visible approved screen scope as evidence, return text or
  action proposals, and optionally speak the response. Local policy executes.
- **Note:** retain audio and literal transcript without reply or dispatch.

The request contract carries an explicit `delivery_intent` rather than guessing
mode from prose. Editor identity and action authority never leave the owning
surface as executable capability.

## Screen evidence

Each surface shows whether semantic context and a screenshot are enabled. A
screenshot binds surface, app/process or tab/package, capture time, dimensions,
digest, and freshness. Secure content is suppressed. The gateway validates the
declared media, attaches bytes only to the current supported multimodal request,
places evidence below an evidence-not-instruction boundary, and persists only
bounded metadata. Denial or capture failure falls back visibly to semantic
context or no context.

## Insertion

Android inserts through `InputConnection.commitText`. Chrome uses a locally
bound editable target and emits a local insertion receipt. macOS binds the
previous focused editable AX element to app, process generation, window, role,
secure/settable state, and a freshness fingerprint, previews exact text, and
records pending/terminal receipts before and after mutation. Focus or app change
requires reconfirmation and causes no mutation.

The Android local proposal seam binds exact text to the expected package and a
semantic `EditorInfo` fingerprint. The user reviews that exact text in the IME
and the dedicated Insert press creates the only approval. Android re-reads the
target immediately before one `InputConnection.commitText`, consumes the
approval before invoking the editor, and records target metadata plus a text
digest. It does not add `ACTION_SET_TEXT`; send remains a separately unsupported
action and no click, editor action, or submit is implied by insertion.

## Staging

Gateway screen evidence, capture lifecycle, and delivery intent are separate
modules. Surface capture, surface insertion, and surface action expansion are
also separate. macOS first integrates the existing typed companion, then proves
an exact QA install, then adds notch layout, microphone transcription, cursor
insertion, and screen-aware actions as independent candidates.

Completion binds one exact candidate identity to deterministic checks, real
surface receipts, preview, safety-gate evidence, promotion, and post-promotion
smoke. Missing device, signing, TCC, live-provider, backup, or rollback evidence
is a blocker, never a pass.

# Android IME Local Insertion Candidate

## Scope

Ticket 4's local safety candidate adds the opt-in Android input-method shell,
manifest metadata and full-app settings entry, sensitive-editor classification,
editor-generation binding, and exact `InputConnection.commitText` insertion.
The only available candidate is fixed local QA text.

This candidate deliberately has no microphone capture, gateway/STT request,
screenshot path, accessibility typing, action expansion, implicit editor action,
submit behavior, candidate history, or deployment authority. Ticket 4 remains
incomplete until production transcription is integrated and physical-device QA
proves ordinary-app insertion plus password and stale-focus refusal.

## Deterministic acceptance

- Password variations, `IME_FLAG_NO_PERSONALIZED_LEARNING`, configured sensitive
  metadata, missing editor identity, and unsupported input classes fail closed.
- Beginning or finishing an editor session clears prior candidate state.
- A candidate binds to one editor identity and generation; changed identity or
  generation authorizes zero text.
- Authorized insertion returns the candidate byte-for-byte for one
  `commitText(text, 1)` call and never invokes an editor action.
- The pure policy gate requires at least 90 percent line, branch, and method
  coverage.

## Physical QA still required

Install and explicitly enable the QA APK on a physical Android device, select
`A.G. Dictation`, and verify exact insertion in two ordinary apps. Then verify a
password editor displays no candidate and cannot stage or insert, and that an
app/field focus change clears the staged candidate. This session does not install
or deploy the APK, so all physical acceptance cells remain blocked/not measured.

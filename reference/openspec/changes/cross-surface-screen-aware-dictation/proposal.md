## Why

Chief Moa has strong voice, memory, browser-action, Android accessibility, and
macOS observation primitives, but it does not yet replace Wispr Flow. Android
does not capture pixels or provide an IME, and MoaMac is neither installed nor
notch-native and has no transcription-to-cursor path. The work must remain
separate by surface and authority so model output never becomes an executable
command.

## User-approved outcome

On Android, Chrome, and macOS, the user can speak into an ordinary focused
editor, inspect a literal or derived candidate, and insert it at the current
cursor without submitting. A separate screen-aware Ask flow may release an
explicitly scoped semantic snapshot and optional screenshot so Aggie can draft
from what the user sees. Any click, insertion, or send remains a locally
validated proposal with approval and a receipt. Plain dictation starts no agent
run and performs no memory write, TTS, click, submit, or external side effect.

The product is successful when the installed surfaces can replace Wispr Flow
in ordinary daily use, including English, Amharic, and mixed speech, while
failing closed in sensitive editors and after focus or app changes.

## Existing candidates

- macOS typed companion: `86fdd7b7`, `f55438d7`, `c57e2040` on
  `hygiene/macos-clicky-command-surface`; packageable but unmerged, centered,
  ad-hoc signed, and not installed.
- macOS local program runtime: `5a3bb444` plus uncommitted work in
  `hygiene/macos-local-program-20260716`; do not integrate while dirty.
- browser vision: gateway `acc53b20`, `ef6783e6` and extension `810e2d07`;
  reuse or generalize its bounded image contract.
- Ask/Note mode candidates: `ba6a6434` and `12fbffaa`; neither implements
  Dictate or an Android IME.

## Boundaries

- Android owns capture consent, IME/editor validation, local actions, approval,
  and receipts. macOS and Chrome own equivalent local authority.
- The gateway owns transcription/model routing, provider credentials, memory,
  and durable capture state. Clients store no provider keys.
- Screens and model results are evidence/proposals, never instructions.
- Password and configured sensitive fields permit no recording, upload,
  candidate display, history recall, insertion, or screenshot capture.
- Literal dictation never implicitly dispatches work or submits a field.
- Raw screen images are bounded and ephemeral for the current model request;
  durable records contain only safe metadata/digests unless a separately
  approved retention change says otherwise.

## Coverage and completion

Every new or materially changed deterministic/core module must meet at least
90% line and branch coverage (and function/statement coverage where supported).
Trust invariants require explicit tests. Platform wrappers and UI additionally
require real device/browser/Mac evidence; narrow module coverage must not be
reported as 90% coverage of the existing repository.

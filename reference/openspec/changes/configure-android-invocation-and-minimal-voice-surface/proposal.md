## Why

Android already distinguishes launcher dictation from system-Assistant turns,
but the user cannot choose presentation style, inspect or configure supported
invocation routes, or reliably pause and cancel from the compact surface. The
2026-08-02 production-turn retranscription also asks for a minimal edge-only
surface while preserving the companion surface, exact message Copy, and fast
provider-neutral voice.

## What Changes

- Add explicit Android invocation behaviors: Dictation, Assistant, and
  Hands-free, while preserving launcher-to-Dictation and system-Assistant-to-
  Assistant as the safe defaults.
- Add Android launcher shortcuts for Settings, Dictation, Assistant, and
  Hands-free, and a full-app mapping surface for triggers Android actually
  exposes to the app.
- Add a selectable presentation style: Companion or Minimal ring. Minimal ring
  keeps the center and every unrendered coordinate touch-pass-through and shows
  microphone activity without creating a full-screen touch window.
- **BREAKING**: In Companion presentation, restore explicit Pause/Resume and
  Cancel beside the mascot, keep Send/turn handoff on the mascot, and keep one
  Copy action inside each populated user or assistant message. This supersedes
  the active clauses that prohibit side controls or limit the compact companion
  to Copy plus a voice-reply toggle.
- Treat edge swipes as an off-by-default experiment. No edge mapping becomes a
  default or hidden control until physical-phone navigation and accessibility
  testing accepts one state table.
- Let Android select only gateway-advertised reasoning/voice profiles. Provider
  credentials remain gateway-owned; Android never accepts or stores raw
  OpenAI, Anthropic, Gemini, xAI, or integration keys.
- Route browser mascot visibility, broader cross-surface Copy parity, voice
  latency prewarm, and provider implementation work to their existing owning
  changes instead of duplicating them here.

## Capabilities

### New Capabilities

- `android-invocation-minimal-voice-surface`: Android invocation routing,
  Companion/Minimal presentation, compact controls, touch authority, and gated
  edge-gesture experiments.

### Modified Capabilities

None. The conflicting contracts exist in active changes rather than archived
base specs; this change explicitly supersedes the named active clauses and must
be reconciled into them before archival.

## Impact

- Android shortcuts, invocation routing, preferences/settings, overlay windows,
  voice state/controller code, accessibility actions, message controls, and
  focused tests.
- Gateway voice-draft capability and profile-options reads are prerequisites;
  this change does not move provider credentials or provider routing into
  Android.
- Android release verification requires lint, assembly, unit tests, a
  continuity-signed preview artifact, real-phone gesture/touch QA, and the
  guarded OTA promotion path.
- Related active changes: `define-android-core-product-map`,
  `voice-first-orb-gestures`, `voice-capture-draft-controls`,
  `overlay-companion-ribbons`, `quiet-companion-controls`,
  `recording-visibility-and-control`, `provider-agnostic-voice-agent-runtime`,
  and `voice-latency-prewarm`.

# Coordinate the companion voice program

## Why

The user asked Chief Moa to own a connected set of product outcomes from intent
through delivery. The request covers Android voice reliability, mobile UI
stability, streaming transcripts, speaking support, a moving companion,
browser parity, later macOS work, calendar planning, and agent-owned delivery.

The repo already has changes for most of these outcomes. Starting another broad
voice or coaching change would split authority and hide the real gaps. This
change records one program, links the existing changes, sets the dependency
order, and defines the evidence needed to move between stages.

## What changes

- Add one source-linked program intake and dependency graph.
- Set stable, diagnosable Android voice as the first milestone.
- Name the existing changes that own each product behavior.
- Define the checks and release evidence for the exact Android candidate.
- Stage companion presence and calendar planning as later changes.
- Keep current implementation claims unchanged until their own checks pass.

## User outcome

The user can state the product direction once and inspect one program record.
That record shows the current milestone, owners, dependencies, candidate,
evidence, blockers, preview, release state, and next action. It does not call a
run complete when the product outcome is still unverified on the target surface.

## First milestone

Deliver one stable, diagnosable Android voice turn on the exact installed
candidate.

The milestone covers the smallest loop that the user can feel and verify:

- the overlay appears in its final saved position without a visible jump;
- the accepted manual voice gesture contract remains the capture authority;
- the user sees partial and final transcript state while speaking;
- a normal turn commits once;
- reply audio finishes, or the UI shows a terminal failure phase;
- manual capture does not re-arm without a visible active grant; and
- retained gateway and phone evidence can explain a failed turn.

Companion motion, calendar integration, richer coaching, browser parity, and
macOS release work do not enter this milestone.

## Existing changes that own behavior

- `define-android-core-product-map` owns Android overlay and full-app behavior.
- `voice-first-orb-gestures` owns manual capture disposition.
- `provider-agnostic-voice-agent-runtime` owns partial STT, normalized voice
  state, interruption, recovery, and failure diagnosis.
- `streaming-cascaded-voice` owns streaming reasoning and TTS behavior. It does
  not own continuous STT.
- `voice-capture-notebook-ime` owns capture blocks, literal and derived text,
  Coach behavior, dictation, and later drills.
- `browser-situated-agent-experience` owns browser workspace and companion
  projection work.
- `companion-catalog-profile-control`, `companion-pet-studio`, and
  `companion-character-voice-library` own companion manifests, catalog, web
  motion, voice binding, and proposal-only motion commands.
- `durable-intent-delivery-pipeline` and `canonical-intent-runtime` own durable
  intent linkage and desired-outcome state.
- `principal-agent-workflows` owns principal role boundaries.
- `voice-intent-completion-loop` owns the evidence matrix and completion
  reducer for fluent and useful voice.
- `context-aware-capability-routing` and the gateway account-connection policy
  own the base for later calendar work.
- `privacy-first-macos-surface` owns native macOS observation and local
  authority.
- `cross-surface-update-delivery` and the release control plane own exact
  candidate release evidence.

## Staged follow-ups

After the first milestone has real-phone evidence, open two narrow changes:

1. `cross-surface-companion-presence` for an optional companion layer that can
   move, react to listening and speaking, respect reduced motion, and stay
   separate from the work surface.
2. `calendar-planning-intents` for a least-privilege, read-only Google Calendar
   day view before any event write proposal.

Those names are reserved follow-up tickets. This change does not authorize
their implementation.

## Non-goals

- Do not create a second transcript, coaching, intent, run, or release store.
- Do not replace the existing surface specs.
- Do not infer that checked source tasks have current independent evidence.
- Do not poll a transcription API every microsecond. Use the existing streaming
  provider and WebSocket event path, then measure time to visible partial text.
- Do not launch overlapping agents against the same Android or browser files.
- Do not deploy or promote from this documentation change.

## Success criteria

- One source-linked program record names every requested outcome and owning
  change.
- One dependency graph separates parallel lanes from serial integration.
- The first milestone has exact acceptance and release evidence.
- Companion and calendar work remain staged follow-up tickets.
- Source task claims remain unchanged until their own verification runs.

# Companion Character + Voice Library

## Why

`companion-pet-studio` shipped the mechanics: Shimeji-style web pets, a
`/pets/` studio, `voice_binding` with consent-gated custom-voice enrollment,
and per-session pet voice/persona overrides. What the user asked for on
2026-07-13 (`__LOG__.md`) is the product on top of those mechanics:

- A character library that is "fully fleshed out", not a demo. Every character
  people care about should exist as a good companion: sprite/animation set,
  persona, and a matching voice.
- Voice cloning embedded in the character, not bolted on. For every selectable
  character there should be a cloned voice, produced through the Google
  cloning API from reference audio.
- A discovery pipeline: search online for the most popular characters, and for
  each one build the companion (sprites, behaviors, persona, voice) mostly
  automatically.
- Command-driven animation: tell the character "walk to the corner", "sit on
  that window", and it does it — motion as a tool the agent can call, built on
  the existing avatar_behavior/pet motion runtime.
- A character builder that is as easy as saying "make me X": natural-language
  creation with optional drag-and-drop refinement, all automated by default.
- Local-first with sharing: characters live in your app, but can be published
  to a shared library others can browse and install. A library of agents, not
  just skins.

## What Changes

- **Character manifest v2**: extend the sanitized `pet` spec with `persona`
  (system-prompt fragment, already session-scoped per pet-studio 4.6),
  `voice_profile` (canonical voice OR cloned-voice reference), `provenance`
  (source character name, reference-media URLs, license/consent state), and a
  `command_verbs` list the animation runtime understands.
- **Cloned-voice pipeline (gateway-owned, consent/allowlist-gated)**: a
  `/v1/agent/pets/:id/voice-clone` job that takes reference audio (uploaded or
  fetched from an operator-approved URL), runs Google's voice-cloning API, and
  stores the resulting voice as a `voice_binding.custom_voice` record. The
  existing enrollment lifecycle from pet-studio 3.1 is the storage contract.
  BLOCKER: Google voice cloning is allowlist-gated on the current project;
  until the allowlist is granted, the pipeline must run in plan/dry-run mode
  and characters fall back to the closest canonical voice.
- **Character discovery worker**: an agent-run job (droplet worker harness)
  that, given a franchise/topic or "most popular" query, searches the web,
  ranks candidate characters, and emits draft manifests (persona draft,
  reference-image links, reference-audio links) into a review queue. Nothing
  publishes without review: copyrighted sprite sheets are never copied
  (pet-studio boundary), generated art in the character's style is used
  instead, and voice cloning of real people or protected performances is a
  consent decision surfaced to the operator, never automatic.
- **Command-driven animation**: expose the pet motion runtime's states (walk,
  climb, fall, drag, idle, wave, target-seek) as an agent tool
  (`companion_motion`) so a voice command like "go to the top right corner"
  becomes a validated motion plan. Same authority model as profile-control:
  model output is a proposal; the client-side runtime validates targets.
- **Builder UX**: `/pets/` gains a "describe it" entry point — one text/voice
  prompt generates manifest + sprites + persona + voice suggestion in one
  pass (existing generation endpoint, extended), with the current manual
  controls demoted to refinement.
- **Shared library**: manifests get `visibility: local | shared`; a
  token-guarded publish/list/install endpoint pair; installs are profile
  patches like today's apply. Moderation/licensing review happens at publish.

## Boundaries

- Gateway owns cloning credentials, clone jobs, and the shared library store.
  The website/Android never see provider credentials (unchanged).
- No copyrighted sprite rips; generated-in-style art only (unchanged from
  pet-studio research note).
- Voice cloning requires explicit consent recording per enrollment; real-person
  voices require operator approval every time. Discovery drafts are inert
  until reviewed.
- Applying/installing a character remains a companion profile patch and grants
  no local action authority.

## Verification

- Gateway: `cd gateway && npm run check` + new smoke for clone-job dry-run,
  manifest v2 round-trip, and `companion_motion` proposal validation.
- Website: `/pets/` builder QA — one prompt produces an applied character with
  a bound voice (canonical fallback while cloning is allowlist-blocked).
- One live voice turn as an installed character verifying persona + voice
  override still hold (pet-studio 4.x contract).

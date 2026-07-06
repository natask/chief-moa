## Why

Users should be able to customize the visible companion from the website before
the Android or extension surfaces grow more UI. Shimeji-style companions are a
good fit because their contract is small: sprite frames, actions, weighted
behaviors, drag, walk, climb, fall, and idle loops.

## What Changes

- Extend companion manifests with a sanitized `pet` spec that describes the web
  renderer, sprite source, palette, motion, behaviors, actions, and generation
  prompt metadata.
- Add token-guarded `/v1/agent/pets` endpoints that mirror the companion catalog
  boundary: list, create, preview, apply, and generate.
- Add a website `/pets/` studio with catalog selection, animated preview,
  drag/move behavior, image upload, create, preview, apply, and generation
  controls.
- Add a website `/pets/library/` catalog page: a browsable, pre-designed pet
  library with animated previews, search and tag filters, and the same
  select-preview-apply flow, so the studio's catalog is discoverable without
  first knowing a companion id.
- Keep Gemini/Vertex image and animation configuration gateway-only. The
  website calls a Pages proxy and never receives provider credentials.
- Add an additive `voice_binding` field to active companion/pet payloads:
  provider, provider voice id, legacy voice alias, preset-only style, and a
  gateway-owned `custom_voice` enrollment record. Applying a pet patches
  `agent_profile.voice` from `voice_binding.provider_voice_id`;
  `agent_profile.voice` stays the runtime source of truth.

## Boundaries

- Applying a pet is applying a companion profile patch; it does not grant local
  action authority.
- The website can preview and draft, but the gateway owns persisted manifests
  and profile history.
- Generated pet media is opt-in. The gateway returns a non-mutating generation
  plan unless live Vertex generation is explicitly enabled.

## Research Notes

- Classic Shimeji stores actions and behaviors as XML and swaps image frames for
  mascot motion.
- Web-native Shimeji variants such as Webmeji use CSS plus JavaScript animation
  loops, `requestAnimationFrame`, drag handling, and a small config file.
- Moa should use the behavior model, not copy copyrighted character sprites.

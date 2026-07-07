## 1. Gateway Pet Contract

- [x] 1.1 Add a sanitized `pet` spec to companion manifests.
- [x] 1.2 Add token-guarded pet list/create/preview/apply endpoints.
- [x] 1.3 Add a non-mutating pet generation endpoint with Vertex model config.
- [x] 1.4 Keep pet apply routed through the existing versioned profile store.
- [x] 1.5 Add saved builder-agent and bookmark endpoints for custom companion
      pets with declarative rules.

## 2. Website Pet Studio

- [x] 2.1 Add `/pets/` as a static app page.
- [x] 2.2 Render Shimeji-style local motion with walk, climb, fall, drag, idle,
      and wave states.
- [x] 2.3 Support catalog search, preview, apply, prompt drafting, palette,
      motion, scale, and image upload.
- [x] 2.4 Add a Pages Function proxy for `/api/pets/*` so gateway credentials
      stay server-side.

## 3. Pet Voice Binding

- [x] 3.1 Spec the additive `voice_binding` contract: apply semantics, old-pet
      defaults, stale-cache behavior, and the consent-gated custom voice
      enrollment lifecycle.
- [x] 3.2 Derive `voice_binding` on gateway active/list/preview/apply payloads
      and keep pet apply patching `agent_profile.voice`.
- [x] 3.3 Bind the active pet palette/motion to the Android overlay orb and
      render cached pet state as stale when active-pet refresh fails.
- [x] 3.4 Surface supported voice choice in the website pet studio through the
      per-pet voice picker.
- [x] 3.5 Surface custom-voice readiness in the website pet studio once the UI
      consumes `voice_binding.custom_voice`.

## 4. Pet Voice Agent (2026-07-06)

- [x] 4.1 Honor the `session_start` per-session `voice` override on the
      cascaded Gemini-TTS legs (streaming pipeline, blocking leg, confirmation
      TTS), pinned once per turn, without mutating the stored profile.
- [x] 4.2 Add a Pages Function (`/api/voice/session-ticket`) that mints
      short-lived voice session tickets server-side so the gateway token never
      reaches browser JS.
- [x] 4.3 Make the `/pets/` pet a voice agent: hold the pet (or press Talk) to
      speak, mic streams pcm16@16k over the ticketed voice websocket, the
      streamed reply audio plays via Web Audio, and the pet animates
      listening/thinking/speaking states.
- [x] 4.4 Add a per-pet Voice picker (the 8 canonical gateway voices) sent as
      the session voice override; a text-only reply stays text (no local
      speech synthesis, per the no-local-TTS rule).
- [x] 4.5 Add a cascaded-voice smoke scenario asserting the override reaches
      every synthesize request and a no-override session keeps the profile
      voice.
- [x] 4.6 Per-session persona: `session_start` carries the pet's name/prompt
      (sanitized, hard-capped, session-scoped); the cascaded reasoner speaks
      in character and identity READS route to chat on persona sessions so
      the pet answers as itself, while profile UPDATES stay profile-control.
- [x] 4.7 Smoke coverage: persona reaches the reasoner input sanitized
      (cascaded-voice smoke) and becomes a system block for that turn only
      (cascaded-reasoner smoke).

## 5. Verification

- [x] 5.1 Add smoke coverage for the gateway pet endpoints.
- [x] 5.2 Run gateway syntax/smoke checks.
- [x] 5.3 Run static website syntax checks and browser QA.
- [x] 5.4 Run gateway `voice_binding` smoke/check coverage after dependencies
      are available.
- [x] 5.5 Run Android debug build after Gradle can create/cache its wrapper and
      bind the required local daemon socket.
- [ ] 5.6 Deployment is blocked until the user explicitly approves promotion.

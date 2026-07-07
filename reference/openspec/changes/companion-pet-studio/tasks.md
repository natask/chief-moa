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
- [ ] 3.4 Surface supported voice choice and custom-voice readiness in the
      website pet studio once the gateway schema is settled.

## 4. Verification

- [x] 4.1 Add smoke coverage for the gateway pet endpoints.
- [x] 4.2 Run gateway syntax/smoke checks.
- [x] 4.3 Run static website syntax checks and browser QA.
- [x] 4.4 Run gateway `voice_binding` smoke/check coverage after dependencies
      are available.
- [x] 4.5 Run Android debug build after Gradle can create/cache its wrapper and
      bind the required local daemon socket.
- [ ] 4.6 Deployment is blocked until the user explicitly approves promotion.

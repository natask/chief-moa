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

## 3. Verification

- [x] 3.1 Add smoke coverage for the gateway pet endpoints.
- [x] 3.2 Run gateway syntax/smoke checks.
- [x] 3.3 Run static website syntax checks and browser QA.
- [ ] 3.4 Deployment is blocked until the user explicitly approves promotion.

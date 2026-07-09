## Tasks

### 1. Gateway Artifact Runtime

- [x] Add a gateway self-extension artifact store with validation, variant
      metadata, active pointers, and a runtime projection.
- [x] Support `avatar_behavior` as the first artifact type.
- [x] Expose token-guarded artifact list/create/apply/runtime endpoints.
- [x] Require source provenance and approval metadata when applying an artifact.
- [x] Add a gateway smoke that creates variants, rejects invalid specs, applies
      one artifact, and verifies runtime persistence after store reload.

### 2. Browser Runtime Consumption

- [x] Add a browser-extension background command that fetches
      `/v1/self-extension/runtime` from the configured gateway.
- [x] Apply active `avatar_behavior` runtime data to the existing Aggie/Lion mark
      through known classes/data attributes only.
- [x] Add CSS mappings for supported avatar motions without executing generated
      JavaScript.
- [x] Preserve the last-good runtime when gateway refresh fails, marked stale.
- [x] Add an extension smoke/static check for the self-extension runtime path.

### 3. Follow-Up Generated UI

- [x] Fetch the existing `/v1/ui/spec` document from the gateway.
- [x] Render known tier-A controls and bounded components in the browser
      overlay, including `card`, `list`, `stat`, and a declarative schematic
      `map` component.
- [ ] Keep richer generated surfaces in sandboxed iframes and reserve
      page-acting code for explicit `userScripts` opt-in.

### 4. Later Capability Expansion

- [ ] Add `theme_spec`, `view_spec`, `workflow_spec`, `tool_binding_spec`, and
      `code_patch_spec` validators behind the same artifact envelope.
- [ ] Add preview comparison, rollback, and artifact search once the first
      avatar behavior runtime is stable.
- [ ] Mirror artifact create/apply events into the canonical product event
      substrate where available.

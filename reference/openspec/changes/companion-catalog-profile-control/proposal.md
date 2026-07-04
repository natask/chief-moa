## Why

Users should shape the assistant by saying what kind of companion they want, not
by editing raw prompts, model settings, or voice fields. Research across GPT
builders, character systems, agent SDKs, MCP, and Chrome MV3 points to the same
boundary: companion identity is a versioned manifest that compiles into runtime
settings; tool authority, memory, and privileged UI code remain separate.

## What Changes

- Add gateway-owned companion manifests with identity, search metadata,
  appearance hints, voice, behavior settings, starter prompts, and smoke prompts.
- Support list/search, draft from natural language, preview, and apply.
- Applying a companion patches the existing versioned runtime profile with
  active companion metadata and behavior fields.
- Route spoken/typed profile-control requests like "I want you to be a research
  scout" through companion creation/apply.
- Extend the browser settings surface with companion search/create/preview/apply
  while keeping the extension a thin client.

## Capabilities

### New Capabilities

- `companion-catalog`: A gateway-owned catalog of built-in and custom companion
  manifests.
- `companion-profile-control`: A profile-control route that creates/previews or
  applies companions through the existing runtime profile store.

## Impact

- Gateway: `lib/companion-catalog.js`, `server.js`, profile fields, and smoke
  coverage.
- Browser extension: `options.html`, `options.js`, verification assertions.
- Docs: architecture primitive and OpenSpec requirements.
- Deployment: gateway and extension are deployable surfaces, but promotion is
  blocked unless the user explicitly approves applying the candidate.

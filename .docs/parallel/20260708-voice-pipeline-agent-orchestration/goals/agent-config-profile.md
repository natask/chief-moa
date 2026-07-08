# Goal: agent-config-profile

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Map the user's requested runtime configuration model onto existing agent profile
and profile-control code: default configuration, named configurations, stable
modes, ephemeral per-session/per-turn mode overrides, voice, speed, input
languages, reply language, tools/skills, and voice demonstration/sampling.

## Target Files

Read only:

- `gateway/lib/agent-profile.js`
- `gateway/lib/profile-options.js`
- `gateway/lib/voice-intent.js`
- `gateway/lib/surface-skills.js`
- `gateway/lib/voice-providers.js`
- `gateway/scripts/smoke-voice-profile.js`
- `gateway/scripts/smoke-profile-revert.js`
- `reference/openspec/changes/provider-agnostic-voice-agent-runtime/*`
- `reference/openspec/changes/gateway-runtime-agent-profile/*`

## Acceptance Criteria

- Report which requested fields already exist and which are missing.
- Propose the minimal data model for configurations and modes without breaking
  current profile version history.
- Identify exact profile tools/endpoints that should change.
- Include verification commands and any migration risks.

## Do Not Touch

No file edits.


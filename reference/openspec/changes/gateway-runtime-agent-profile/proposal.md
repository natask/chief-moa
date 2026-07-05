## Why

The gateway's behavior is fixed by the `SYSTEM_PROMPT` env var, read once at
boot (`server.js:26`). Changing how agee behaves means editing an env file on the
main machine and restarting. To let the user customize behavior from the
extension, the gateway must first expose a runtime-editable agent profile.

## What Changes

- Treat `SYSTEM_PROMPT` env as the immutable default; compute an effective
  profile = persisted profile (if any) else the env default.
- Read the effective profile per request in `/v1/chat` and `/v1/voice/turns`
  instead of the boot constant; no behavior change when nothing is overridden.
- Add token-guarded `GET`, `PUT`, and reset endpoints for the profile.
- Accept a per-request `profile_overrides` field that merges for one request
  only and is not persisted.

## Capabilities

### New Capabilities

- `runtime-agent-profile`: Gateway endpoints and storage to read, update, reset,
  and per-request override the effective agent profile at runtime without a
  restart, layered over the env default.

## Impact

- `gateway/server.js` and `lib/` (profile store under `data/`,
  endpoints, per-request merge). Builds toward `agent-profile-control-plane` from
  `provider-agnostic-voice-agent-runtime`; keep field names aligned for later
  reconciliation. No dependency on the extension changes.

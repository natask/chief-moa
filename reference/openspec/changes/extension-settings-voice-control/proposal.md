## Why

Stage 1 of engine-driven customization from the extension surface. Under
`thin-client-gateway-architecture`, the browser extension is a stable thin
client and the persistent engine owns secrets, model calls, runtime profile, and
customization state. The settings surface therefore configures the engine
connection and engine-owned profile; it is not a browser-side provider console.

This builds on `gateway-runtime-agent-profile`: the runtime agent profile (system
prompt and behavior) is one of the settings this surface reads and writes.

## What Changes

- Provide a settings surface in the extension for engine connection state
  (gateway URL/session token) and engine-owned runtime profile fields such as
  system prompt and model selection.
- Let the user change settings by speaking/typing to the agent: a settings-intent
  path that turns "make yourself terser", "set the system prompt to ...", or
  "add a setting for X" into concrete settings changes applied via the gateway
  profile / extension config.
- Reflect agent-applied changes live in the settings surface so spoken changes
  and the visible page stay in sync.
- Keep provider API keys, subscriptions, model calls, and customization
  persistence on the engine side. The extension may hold only the engine
  connection/session state needed to reach that engine.

## Capabilities

### New Capabilities

- `extension-settings-surface`: A settings surface for the extension's
  configuration, kept in sync with the gateway runtime profile.
- `agent-controlled-settings`: A path where the user changes settings by talking
  to the agent, and the agent applies them to the profile/config.

## Impact

- `browser_extension/extension/options.*` (or a dedicated settings
  surface), `background.js` (settings-intent routing into the gateway profile
  endpoints). Depends on `gateway-runtime-agent-profile`,
  `extension-gateway-roundtrip`, and the thin-client decision. The deeper
  "agent changes the settings page structure itself" belongs to
  `extension-ui-self-extension` and must travel as engine-served customization,
  not as repackaged extension code.

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
  path that turns "make yourself terser" or "set the system prompt to ..." into
  concrete settings changes applied through the setting owner's validated
  gateway-profile or extension-local path.
- Give the agent a queryable catalog of canonical gateway runtime-profile
  settings so the user can list, explain, semantically search, compare, and ask
  for useful recommendations without already knowing exact setting labels.
  Merging browser-local controls into that projection is a follow-up; this
  browser change does not claim an Android settings registry.
- Project catalog results as selectable visual controls in the existing command
  or workspace surface. Options remains the deep configuration and Chrome
  permission-remediation surface rather than the only place settings can be
  discovered.
- Never invent a setting, feature flag, or hidden preference while handling an
  ordinary product request. Adding a new setting is explicit product-change
  work, separate from reading or mutating a registered setting.
- Reflect agent-applied changes live in the settings surface so spoken changes
  and the visible page stay in sync.
- Keep provider API keys, subscriptions, model calls, and customization
  persistence on the engine side. The extension may hold only the engine
  connection/session state needed to reach that engine.

## Implemented Slice Boundary

The gateway implements a read-only catalog over its canonical runtime profile,
including list, exact get, deterministic meaning/alias search, recommendation,
current/default values, constraints, redaction, and rejection of unknown
settings. The same catalog is available through authenticated HTTP routes and
the gateway voice agent's `read_agent_settings` tool.

The current browser does not yet merge extension-local controls into that
catalog, render catalog results in a Command-K-style surface, or broker generic
extension-local writes. Android preferences remain Android-owned and are not
enumerated or mutated by this browser/gateway slice.

## Capabilities

### New Capabilities

- `extension-settings-surface`: A settings surface for the extension's
  configuration, kept in sync with the gateway runtime profile.
- `agent-controlled-settings`: A path where the user changes settings by talking
  to the agent, and the agent reads or applies registered settings through their
  owning profile/config boundary.

## Impact

- `browser_extension/extension/options.*` (or a dedicated settings
  surface), `background.js` (settings-intent routing into the gateway profile
  endpoints). Depends on `gateway-runtime-agent-profile`,
  `extension-gateway-roundtrip`, and the thin-client decision. The deeper
  "agent changes the settings page structure itself" belongs to
  `extension-ui-self-extension` and must travel as engine-served customization,
  not as repackaged extension code.

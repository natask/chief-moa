## Why

Stage 2 of engine-served customization. Beyond changing settings values (Stage
1), the extension's interface can grow: add features, add new UI elements, and
display new things. `thin-client-gateway-architecture` settles the load-bearing
boundary: the extension package is stable, and the persistent engine is the
deployment target.

## What Changes

- The extension can gain new UI elements/features and display new things, driven
  by the user rather than only by a rebuild.
- New UI ships first as an engine-served declarative UI spec interpreted by the
  extension renderer. Richer generated surfaces run in sandboxed iframes.
  Page-acting generated code is reserved for `userScripts` with explicit
  per-extension opt-in and inspectability.
- Deployment never repackages or reloads privileged extension code for an end
  user.

## Capabilities

### New Capabilities

- `extension-ui-self-extension`: The extension's interface can be extended with
  new elements and displays. Scope intentionally unresolved pending design.

## Resolved Boundary

The core boundary is now set by `thin-client-gateway-architecture`:

- Hand-built extension code provides the stable renderer, broker, and safety
  checks.
- Agent/user-generated customization travels as data by default: declarative UI
  spec interpreted by that renderer.
- Rich generated UI is sandboxed; generated page-acting scripts require
  `userScripts`, explicit opt-in, and inspection before execution.

## Impact

- `browser_extension/extension/` UI surfaces and `gateway`
  customization serving/storage. Implementation tasks should target the engine
  spec -> renderer path first; do not introduce a promote-gate or end-user
  package reload path.

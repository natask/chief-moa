# AgentBoard-Inspired Injected Browser Tools

## Status

Accepted first slice and implemented for user-installed tools on 2026-07-29.
This is a clean-room product decision based on the public AgentBoard behavior,
not copied source.

## Useful Prior Art

AgentBoard treats the browser as a tab-scoped tool host. Pages and injected
scripts can register named JavaScript tools with structured input schemas; a
registry projects the applicable tools to an agent and routes calls back to the
owning tab. Its sidebar also makes the active tools auditable.

Ag adopts the composability and visibility, with a stricter authority source:

- the extension-owned Settings surface installs exact reviewed source;
- a closed primitive JSON schema bounds agent-controlled arguments;
- exact URL match patterns bind where the tool may run;
- only tools whose local Chrome user-script capability is available are
  advertised in the device manifest;
- the gateway exposes the live installed names to code-mode agents and pins a
  request to the advertising browser device;
- the browser revalidates name, arguments, URL, tab, document, and runtime,
  executes in `USER_SCRIPT`, bounds output, and emits digest-bound receipts;
- the first slice accepts only a declared read effect; page-change tools wait
  for a per-call checkpoint runtime;
- the side panel shows packaged and injected tools with risk and approval
  metadata.

## Deliberate Differences

Page content remains evidence and cannot register an executable tool. Ag does
not preserve or polyfill a page-owned `document.modelContext`, route arbitrary
remote MCP credentials into the tab, or infer trust from a tool description.
Generated one-off programs remain `moa.browser-program.v2` proposals with their
own execution-profile and delegation requirements. `MAIN`, CDP, extension
bridge access, destructive application effects, and secret-bearing arguments
remain separate future grants/checkpoints rather than properties of an
installed tool.

## Acceptance Evidence

- Unit coverage proves save/list/manifest, closed-schema validation, exact-host
  scope, `USER_SCRIPT` execution, bounded results, digest receipts, and the
  default-off capability gate.
- Gateway coverage proves only the exact tools advertised by the current
  browser device become callable and that the request is pinned to that device.
- Extension verify and real Chrome smoke remain the release gates.

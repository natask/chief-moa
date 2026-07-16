# Tasks

## Contract and protocol

- [x] Record the cross-surface product direction, runtime profiles, trust
  boundaries, closed proposal/event/receipt shapes, honest recovery semantics,
  isolated-QA rules, and focused coverage gate.
- [x] Add the normative `surface-local-program-execution` specification and
  reflect the architecture-significant boundary in `ARCHITECTURE.md`.
- [ ] Implement shared closed-schema decoders, canonical digests, lifecycle
  sequencing, replay protection, receipt validation, and exact-target routing.
- [ ] Add adversarial protocol tests for unknown fields/types, legacy executable
  fields, source/catalog/state drift, replay, forged receipts, profile
  escalation, budget enforcement, interruption, and sensitive-data omission.

## Gateway and server-side runtime

- [ ] Route complete program proposals/events/receipts without proxying each
  client-local primitive call through the gateway.
- [ ] Restrict `gateway.quickjs.v1` to gateway-owned functions and prove client
  DOM, Android Accessibility, macOS AX/TCC, and client credentials are absent.
- [ ] Verify new executable gateway/protocol modules independently exceed 90%
  line and branch coverage, then run `cd gateway && npm run check`.

## Browser runtime

- [ ] Add `browser.javascript.v1` with a fresh sandboxed local realm, immutable
  tools namespace, local scheduler, budgets, stop handling, events, and
  receipts.
- [ ] Adapt packaged tab, observation, DOM, keyboard, screenshot, CDP, anchor,
  and userscript functions; keep page evaluation separately capability- and
  site-grant-bound.
- [ ] Prove multi-call branching, compatible parallel reads, stale-document
  rejection, sensitive-state omission, interruption, and honest cleanup using
  local fixture origins and a disposable browser profile only.
- [ ] Verify each new executable browser module independently exceeds 90% line
  and branch coverage, then run `cd browser_extension && npm run verify && npm
  run smoke` without capturing or packaging a personal page.

## Android runtime

- [ ] Add `android.webview-js.v1` in a dedicated non-visible WebView with a
  fresh realm, no user browsing state/network/file access, and a narrow
  asynchronous Java/Kotlin message bridge.
- [ ] Expose Android Accessibility-first observation and semantic action host
  functions over existing local policy/approval/receipt primitives; retain
  intents only for safe platform handoffs.
- [ ] Prove multi-call branching, stale package/window/node rejection, no
  coordinate fallback, interruption, and receipt durability against an
  isolated fixture APK/emulator or explicitly dedicated device.
- [ ] Verify each new executable Android module independently exceeds 90% line
  and branch coverage, then run `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew test assembleDebug`.

## macOS and desktop runtime

- [ ] Add `macos.javascriptcore-ax.v1` with a per-program `JSContext`, immutable
  Swift bridge, public semantic AX adapters, local grant/approval checks,
  budgets, stop handling, and durable receipts.
- [ ] Add JXA/AppleScript and bounded shell only as separate opt-in runtime
  profiles with exact target/command/filesystem/network policies and no
  inherited AX, Apple Events, shell, Keychain, or host-environment authority.
- [ ] Prove AX execution and profile separation against a dedicated fixture app
  in an isolated account/VM; automated QA must not inspect or capture the
  user's foreground desktop.
- [ ] Verify each new executable macOS module independently exceeds 90% line and
  branch coverage, then run `cd apple_surfaces && swift test && swift build
  --product MoaMac` and produce only the evidenced unsigned QA artifact.

## Integration and release evidence

- [ ] Independently verify exact clean candidates, then integrate protocol,
  gateway, browser, Android, and macOS commits in dependency order.
- [ ] Run cross-surface fixture smoke tests proving one proposal can drive many
  local calls while external/irreversible effects pause at local policy.
- [ ] Create the existing release artifact or preview for each changed
  deployable surface. Install or actively promote only after signing, rollback,
  compatibility, no-interruption, state, backup/restore, and post-install smoke
  gates are proven; otherwise record the precise blocker.

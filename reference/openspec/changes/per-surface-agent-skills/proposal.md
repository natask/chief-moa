# Per-Surface Agent Skills

## Why

Moa's model already calls tools for profile control and page tweaks, but two
product asks have no wire path yet. First, the user wants a browser agent that
works in the background: open tabs the user does not see, navigate, read
pages, click and type, and carry out multi-step research, extracted from the
agee action-loop prior art and executed only through the extension's own
allowlisted local execution. Second, the user wants phone automations —
"open app X", "call person Y", "open a URL" — driven by the assistant
pipeline through code-mode execution (the QuickJS `execute` tool), with the
phone claiming and executing the local tool. Both asks share one root gap: the
skills offered to the model today do not depend on which surface (phone or
browser) started the turn, and there is no gateway-owned browser agent-loop
task to drive a background tab through observe/act steps. Chat history stays
shared across surfaces (one default session); only the offered skill set
should vary by origin.

## What Changes

- Add a gateway-owned `browser_agent_task` primitive and store
  (`gateway/lib/browser-agent-loop.js`, `DATA_DIR/browser-agent-tasks/`) with
  create/claim/step/finish endpoints under `/v1/browser/agent-tasks`. Each
  task links a non-blocking `agent_run` for observability. The gateway
  proposes exactly one bounded declarative action per step from a fixed
  vocabulary (click, type, clear, select, scroll, navigate, key, wait,
  screenshot, finish); that fixed-action endpoint does not carry CSS/JS/code
  strings. The surface-program endpoint handles granted code separately. A deterministic
  keyless fallback (wait then finish) keeps the loop smoke-able with no model
  key configured.
- Add a per-surface skill registry (`gateway/lib/surface-skills.js`) that
  resolves the originating surface (`resolveTurnSurface`: android-overlay/
  android -> android; agee-extension/browser -> browser) and merges
  surface-appropriate code-mode capabilities into the existing cascaded
  execute tool set: cross-device phone tools (`phone_open_app`,
  `phone_open_url`, `phone_dial`, `phone_open_contact`) available on every
  surface since cross-device control is the point of the hub, plus
  `browser_agent_task` and `browser_open_tab`. Classic (non-code-mode) tool
  defs (`phone_action`, `launch_background_browser_task`) cover the same
  ground when the `execute` tool is off. `VOICE_EXECUTE_TOOL` default flips
  from off to on.
- Add three Android broker tools serviced through the cross-device tool hub:
  `url.open` (ACTION_VIEW, http/https only), `phone.dial` (ACTION_DIAL,
  pre-fills the dialer, never places the call), and `contact.open`
  (ContactsContract lookup behind `READ_CONTACTS`, with a clear
  permission-missing result instead of a crash).
- Extend the browser extension's background poll loop to claim agent-loop
  tasks, drive them in a non-activated background tab through the existing
  content-script act path, and post step/finish receipts, gated by a new
  settings toggle (default on).
- Verify the already-shipped current-page Q&A path (`/v1/browser/turns`,
  `/v1/browser/evidence`) is unaffected.

## Decision Record: Android Two-App Split (Deferred)

Considered: splitting the Android app into a store-safe app (chat, voice,
approvals) plus a separate executor companion app that holds the
accessibility service and broker execution authority, on the theory that a
Play Store listing would reject an app that grants itself broad
accessibility/execution power.

Decision: defer. Distribution today is gateway OTA sideload
(`GET /v1/android/updates/latest` + package-installer install), not a Play
Store listing. A two-app split adds real engineering cost (cross-app IPC,
duplicated approval UI, two signing/update paths) and buys no capability
under sideload distribution, since there is no store review gate to satisfy.
The single app keeps accessibility, overlay, and broker authority together,
matching every other boundary in this repo (Android owns local execution;
the gateway only proposes). Revisit this decision if and when store
distribution becomes an explicit product goal.

## Non-Goals

- No change to the shipped page Q&A path beyond verification.
- No implicit code authority from the fixed action vocabulary. Broader browser
  JS/TS or CDP execution uses the separately granted surface-program contract.
- No Android two-app split (see decision record above).
- No change to `phone.dial` that would place a call without the user pressing
  call, and no `CALL_PHONE` permission.
- No live gateway deploy, Android OTA publish, or browser-extension reload
  without the active-promotion gate passing.

## Boundaries

- The gateway proposes typed actions or hash-bound surface programs. Provider
  keys stay gateway-side, and the owning surface validates every proposal.
- The browser extension validates every proposed action against its own
  local allowlist before executing it, and never activates the task's
  background tab.
- The Android broker validates every claimed tool against its own capability
  manifest before executing it, and degrades missing permissions to a result
  instead of crashing.
- Per-surface skills change what the model can call; they do not change who
  validates and executes it. Execution authority stays with the client that
  owns the surface (Android or the extension), never the gateway.

## Verification

- Gateway: `cd gateway && npm run check && npm run smoke:browser-agent-loop
  && npm run smoke:surface-skills && npm run smoke:device-hub && npm run
  smoke:execute-engine`.
- Browser extension: `cd browser_extension && npm run verify && npm run smoke
  && npm run smoke:agent-loop && npm run smoke:unified-browser-agent`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew test assembleDebug`.
- Docs: this OpenSpec change plus `ARCHITECTURE.md` match
  `scratch/agent-loop/2026-07-06-per-surface-agents/CONTRACT.md` exactly.

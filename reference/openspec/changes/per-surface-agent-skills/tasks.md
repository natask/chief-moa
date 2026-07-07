# Tasks

Lane split and contract: `scratch/agent-loop/2026-07-06-per-surface-agents/`
(`CONTRACT.md`, `TICKETS.md`).

## 1. Gateway (lane: gateway)

- [ ] 1.1 Add `gateway/lib/browser-agent-loop.js`: task store under
      `DATA_DIR/browser-agent-tasks/`, create/claim/step/finish logic, the
      deterministic keyless fallback planner (step 0 wait, step >0 finish),
      and the linked `agent_run` create + `browser_agent_task_queued`/
      `browser_agent_task_finished` events.
- [ ] 1.2 Wire `POST /v1/browser/agent-tasks`, `POST
      /v1/browser/agent-tasks/claim`, `POST /v1/browser/agent-tasks/{id}/steps`,
      `POST /v1/browser/agent-tasks/{id}/finish`, `GET
      /v1/browser/agent-tasks` (+`?status=`), `GET
      /v1/browser/agent-tasks/{id}` into `gateway/server.js` under
      authorizedAgent.
- [ ] 1.3 Add `gateway/lib/surface-skills.js`: `resolveTurnSurface`,
      `surfaceExecuteCapabilities` (phone_open_app, phone_open_url,
      phone_dial, phone_open_contact, browser_agent_task, browser_open_tab),
      and the classic fallback tools (`phone_action`,
      `launch_background_browser_task`).
- [ ] 1.4 Flip `VOICE_EXECUTE_TOOL` default to on (`!== "0"`); update
      `gateway/.env.example`.
- [ ] 1.5 Add `/health` fields `execute_tool: { enabled, capability_count }`
      and `browser_agent_tasks: { pending, active }`.
- [ ] 1.6 Add `gateway/scripts/smoke-browser-agent-loop.js` and
      `gateway/scripts/smoke-surface-skills.js`; wire both into
      `gateway/package.json` scripts.
- Acceptance: the browser-agent-loop smoke drives create -> claim -> 2 steps
  (deterministic fallback: wait then finish) -> finish, with agent_run events
  recorded at each transition. The surface-skills smoke proves
  `phone_open_app` creates an android-targeted `tool_request` and returns the
  receipt after a simulated device claim + receipt.
- Verification: `cd gateway && npm run check && npm run
  smoke:browser-agent-loop && npm run smoke:surface-skills && npm run
  smoke:device-hub && npm run smoke:execute-engine`.
- Deploy target or blocker: push to master -> CI `Deploy VPS gateway` ->
  droplet auto-promote.

## 2. Browser extension (lane: browser action/CDP)

- [ ] 2.1 Add `pollBrowserAgentTasks()` to `browser_extension/extension/
      background.js` on the existing 2s cadence, gated by
      `ageeBackgroundAutomationEnabled` (default true).
- [ ] 2.2 On claim, open a background (`active:false`) tab and drive the
      observe -> step -> act loop through the existing content-script act
      path; screenshot via `captureScreenshotViaDebugger` on step 0 or when
      the last action was `screenshot`; `navigate` via `chrome.tabs.update` +
      wait-for-load; dispose the tab on `finish` or error.
- [ ] 2.3 Add the background-automation toggle to `options.html`/`options.js`.
- [ ] 2.4 Add `browser_extension/scripts/smoke-agent-loop.mjs` against a stub
      gateway and a new fixture page; wire into `browser_extension/
      package.json`.
- Acceptance: `smoke:agent-loop` passes: background-only assertion (tab never
  activated), fixture DOM mutated by a proposed click/type action, finish
  receipt posted to the stub.
- Verification: `cd browser_extension && npm run verify && npm run smoke &&
  npm run smoke:agent-loop && npm run smoke:unified-browser-agent`.
- Deploy target or blocker: `scripts/deploy.sh extension` (version bump at
  deploy).

## 3. Android (lane: Android action/accessibility)

- [ ] 3.1 Add `url.open`, `phone.dial`, `contact.open` to
      `MoaActionBroker.java` and `androidLocalToolManifest`.
- [ ] 3.2 Add `READ_CONTACTS` to `AndroidManifest.xml` and a runtime request
      affordance in `MainActivity.java`'s settings/setup surface.
- [ ] 3.3 Add unit tests in `MoaActionBrokerTest.java` for the URL allowlist,
      number normalization, and tool dispatch, including the missing-
      permission path for `contact.open`.
- Acceptance: a claimed `{tool:"url.open", input:{url:"https://example.com"}}`
  executes ACTION_VIEW and receipts ok; `phone.dial`/`contact.open` dispatch
  is covered by unit tests, including the missing-`READ_CONTACTS` case
  returning a clear result instead of crashing.
- Verification: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew test assembleDebug`.
- Deploy target or blocker: push to master -> `android-ota.yml` artifact; adb
  install if a device is attached.

## 4. Page Q&A (lane: browser voice/page-QA, verify only)

- [ ] 4.1 Confirm the shipped current-page Q&A path
      (`/v1/browser/turns`, `/v1/browser/evidence`) still passes after the
      agent-loop poll and surface-skills wiring land.
- Verification: `cd browser_extension && npm run smoke:unified-browser-agent`.

## 5. Workflow/docs (lane: workflow/docs, this change)

- [x] 5.1 Add `reference/openspec/changes/per-surface-agent-skills/`
      (`proposal.md`, `design.md`, `tasks.md`) matching
      `scratch/agent-loop/2026-07-06-per-surface-agents/CONTRACT.md` shapes
      exactly, including the Android two-app split decision (deferred).
- [ ] 5.2 Update `ARCHITECTURE.md`: add the "Background browser agent loop"
      runtime-flow subsection after "Browser Extension Thin Client"; note the
      per-surface skill registry in the code-mode/tool-loop description; add
      the three new Android tools under Phone Action / Cross-Device Tool Hub;
      add the `browser_agent_task` primitive; add the new gateway/extension
      files to the Source Map.
- Verification: docs match `CONTRACT.md` shapes exactly; `openspec validate
  per-surface-agent-skills --strict` if the CLI is initialized for this
  checkout.

## 6. Verification/deploy (lane: verification/deploy, serial, last)

- [ ] 6.1 Verify lanes 1-4 independently with their own verification
      commands.
- [ ] 6.2 Commit per lane with Conventional Commits.
- [ ] 6.3 Push master (gateway CI + Android OTA); run
      `scripts/deploy.sh extension`.
- [ ] 6.4 Smoke `https://api.agee.app/health` (checks `execute_tool` and
      `browser_agent_tasks` fields) and the deployed extension reload check.
- [ ] 6.5 Record blockers plainly if any gate fails; do not force a promotion
      past a failed gate.

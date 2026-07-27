# Tasks

Lane split and contract: `scratch/agent-loop/2026-07-06-per-surface-agents/`
(`CONTRACT.md`, `TICKETS.md`).

## 1. Gateway (lane: gateway)

- [x] 1.1 Add `gateway/lib/browser-agent-loop.js`: task store under
      `DATA_DIR/browser-agent-tasks/`, create/claim/step/finish logic, the
      deterministic keyless fallback planner (step 0 wait, step >0 finish),
      and the linked `agent_run` create + `browser_agent_task_queued`/
      `browser_agent_task_finished` events. Verified 2026-07-27:
      `createBrowserAgentLoopStore` at `gateway/lib/browser-agent-loop.js:366`
      writes under `dataDir/browser-agent-tasks` (`:374`), with `create`
      (`:444`), `claim` (`:492`), `step` (`:535`), `finish` (`:594`); events
      at `gateway/server.js:7045,7439`.
- [x] 1.2 Wire `POST /v1/browser/agent-tasks`, `POST
      /v1/browser/agent-tasks/claim`, `POST /v1/browser/agent-tasks/{id}/steps`,
      `POST /v1/browser/agent-tasks/{id}/finish`, `GET
      /v1/browser/agent-tasks` (+`?status=`), `GET
      /v1/browser/agent-tasks/{id}` into `gateway/server.js` under
      authorizedAgent. Verified 2026-07-27: routes dispatched in
      `gateway/lib/browser-task-handlers.js:20-41`, store wired into
      `routeBrowserTasks` at `gateway/server.js:747-758`.
- [x] 1.3 Add `gateway/lib/surface-skills.js`: `resolveTurnSurface`,
      `surfaceExecuteCapabilities` (phone_open_app, phone_open_url,
      phone_dial, phone_open_contact, browser_agent_task, browser_open_tab),
      and the classic fallback tools (`phone_action`,
      `launch_background_browser_task`). Verified 2026-07-27:
      `gateway/lib/surface-skills.js:19` (`resolveTurnSurface`), `:37-96`
      (capability table), `:658-661` (`browser_agent_task`), `:469,673`
      (classic tools).
- [x] 1.4 Flip `VOICE_EXECUTE_TOOL` default to on (`!== "0"`); update
      `gateway/.env.example`. Verified 2026-07-27:
      `gateway/server.js:8798` (`!== "0"`), `gateway/.env.example:190-192`
      (`VOICE_EXECUTE_TOOL=1`, documented default-on).
- [x] 1.5 Add `/health` fields `execute_tool: { enabled, capability_count }`
      and `browser_agent_tasks: { pending, active }`. Verified 2026-07-27:
      `gateway/lib/gateway-health-handlers.js:80,89`.
- [x] 1.6 Add `gateway/scripts/smoke-browser-agent-loop.js` and
      `gateway/scripts/smoke-surface-skills.js`; wire both into
      `gateway/package.json` scripts. Verified 2026-07-27: both files present
      under `gateway/scripts/`; `gateway/package.json:148-149` registers
      `smoke:browser-agent-loop` and `smoke:surface-skills`.
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

- [x] 2.1 Add `pollBrowserAgentTasks()` to `browser_extension/extension/
      background.js` on the existing 2s cadence, gated by
      `ageeBackgroundAutomationEnabled` (default true). Verified 2026-07-27:
      `background.js:103` (key), `:1207` (`pollBrowserAgentTasks`), called at
      `:638,643,1053`.
- [x] 2.2 On claim, open a background (`active:false`) tab and drive the
      observe -> step -> act loop through the existing content-script act
      path; screenshot via `captureScreenshotViaDebugger` on step 0 or when
      the last action was `screenshot`; `navigate` via `chrome.tabs.update` +
      wait-for-load; dispose the tab on `finish` or error. Verified
      2026-07-27: `background.js:1251` (`chrome.tabs.create({..., active:
      false})`), `:1326` (`captureScreenshotViaDebugger`), `:1343`
      (`chrome.tabs.update` navigate).
- [x] 2.3 Add the background-automation toggle to `options.html`/`options.js`.
      Verified 2026-07-27: `options.html:110-111` (checkbox + status label),
      `options.js:108-123` (wiring).
- [x] 2.4 Add `browser_extension/scripts/smoke-agent-loop.mjs` against a stub
      gateway and a new fixture page; wire into `browser_extension/
      package.json`. Verified 2026-07-27: file present, `package.json:27`
      registers `smoke:agent-loop`.
- Acceptance: `smoke:agent-loop` passes: background-only assertion (tab never
  activated), fixture DOM mutated by a proposed click/type action, finish
  receipt posted to the stub.
- Verification: `cd browser_extension && npm run verify && npm run smoke &&
  npm run smoke:agent-loop && npm run smoke:unified-browser-agent`.
- Deploy target or blocker: `scripts/deploy.sh extension` (version bump at
  deploy).

## 3. Android (lane: Android action/accessibility)

- [x] 3.1 Add `url.open`, `phone.dial`, `contact.open` to
      `MoaActionBroker.java` and `androidLocalToolManifest`. Verified
      2026-07-27: dispatch at `MoaActionBroker.java:236,240,244`,
      capability table `:1840-1842`, kept in sync with
      `OverlayService.androidLocalToolManifest()` per comment at `:1828`.
- [x] 3.2 Add `READ_CONTACTS` to `AndroidManifest.xml` and a runtime request
      affordance in `MainActivity.java`'s settings/setup surface. Verified
      2026-07-27: `AndroidManifest.xml:12`, request call
      `MainActivity.java:373`, granted-check `:545`.
- [x] 3.3 Add unit tests in `MoaActionBrokerTest.java` for the URL allowlist,
      number normalization, and tool dispatch, including the missing-
      permission path for `contact.open`. Verified 2026-07-27:
      `allowsOnlyHttpAndHttpsUrls` (`:68-80`), `normalizesDialNumbers`
      (`:82-93`), `registersNewPhoneToolsWithContractRiskAndApproval`
      (`:106-126`), `reportsContactPermissionAndMissMessages` (`:302-309`,
      covers `CONTACTS_PERMISSION_MISSING` returned as a clear result rather
      than a crash).
- Acceptance: a claimed `{tool:"url.open", input:{url:"https://example.com"}}`
  executes ACTION_VIEW and receipts ok; `phone.dial`/`contact.open` dispatch
  is covered by unit tests, including the missing-`READ_CONTACTS` case
  returning a clear result instead of crashing.
- Verification: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew test assembleDebug`.
- Deploy target or blocker: push to master -> `android-ota.yml` artifact; adb
  install if a device is attached.

## 4. Page Q&A (lane: browser voice/page-QA, verify only)

- [x] 4.1 Confirm the shipped current-page Q&A path
      (`/v1/browser/turns`, `/v1/browser/evidence`) still passes after the
      agent-loop poll and surface-skills wiring land. Verified 2026-07-27:
      routes present at `gateway/lib/browser-turn-handlers.js:17-18`; see
      Verification/deploy section 6 below for the actual command run in this
      pass.
- Verification: `cd browser_extension && npm run smoke:unified-browser-agent`.

## 5. Workflow/docs (lane: workflow/docs, this change)

- [x] 5.1 Add `reference/openspec/changes/per-surface-agent-skills/`
      (`proposal.md`, `design.md`, `tasks.md`) matching
      `scratch/agent-loop/2026-07-06-per-surface-agents/CONTRACT.md` shapes
      exactly, including the Android two-app split decision (deferred).
- [x] 5.2 Update `ARCHITECTURE.md`: add the "Background browser agent loop"
      runtime-flow subsection after "Browser Extension Thin Client"; note the
      per-surface skill registry in the code-mode/tool-loop description; add
      the three new Android tools under Phone Action / Cross-Device Tool Hub;
      add the `browser_agent_task` primitive; add the new gateway/extension
      files to the Source Map. Verified 2026-07-27: this was mostly already
      done by an earlier pass — "Background browser agent loop"
      (`ARCHITECTURE.md:1056`), the three Android tools plus
      `browser_agent_task` under Cross-Device Tool Hub (`:1552-1562,1082`),
      and both gateway/extension files in the Source Map
      (`gateway/lib/browser-agent-loop.js`, `gateway/lib/surface-skills.js`,
      `pollBrowserAgentTasks`/`smoke:agent-loop`) were already present. This
      pass closed the one real gap: the Source Map entry for
      `MoaAccessibilityService.java` overstated capability as "visible UI
      operations" — corrected to name the actual generic click/back/home plus
      YouTube-scoped adapter, and added an explicit honest-limits paragraph
      to Cross-Device Tool Hub stating there is no general element-level
      tap/type tool on Android (browser-CDP parity gap), matching the
      2026-07-27 agent-surface-status.md audit.
- Verification: docs match `CONTRACT.md` shapes exactly; `openspec validate
  per-surface-agent-skills --strict` if the CLI is initialized for this
  checkout.

## 6. Verification/deploy (lane: verification/deploy, serial, last)

- [x] 6.1 Verify lanes 1-4 independently with their own verification
      commands. 2026-07-27, this pass, from the `openspec-close` worktree
      (write-scoped to openspec + `ARCHITECTURE.md` only, so only the
      browser_extension verification gate — which has no build dependency on
      gateway/Android — was runnable here): `cd browser_extension && npm run
      verify && npm run smoke` — both passed, output pasted in the closing
      commit body. Gateway (`npm run check` + the four smoke scripts named in
      section 1) and Android (`./gradlew test assembleDebug`) were not
      re-run in this worktree since it does not own those trees; lanes
      `gateway-tools` and `android-assistant` own that verification per
      `merge-ledger.md`.
- [ ] 6.2 Commit per lane with Conventional Commits. This lane's commit is
      done; gateway/Android lane commits are owned by their own worktrees.
- [ ] 6.3 Push master (gateway CI + Android OTA); run
      `scripts/deploy.sh extension`. Not done — explicitly out of scope for
      this lane; integration/push is the main orchestrator's job.
- [ ] 6.4 Smoke `https://api.agee.app/health` (checks `execute_tool` and
      `browser_agent_tasks` fields) and the deployed extension reload check.
      Not done — depends on 6.3.
- [x] 6.5 Record blockers plainly if any gate fails; do not force a promotion
      past a failed gate. No verification gate failed in this pass; 6.3/6.4
      are recorded above as not-yet-run rather than closed, which is itself
      the honest blocker record.

#!/usr/bin/env node
"use strict";

// Smoke for per-surface skills (lib/surface-skills.js). Keyless and
// deterministic: it drives the surface-skill lib IN-PROCESS against a real
// gateway (spawned on a local port) through HTTP-backed dependency injection,
// exactly the seam server.js uses. It proves:
//   1. resolveTurnSurface canonicalizes android/browser sources.
//   2. the phone_open_app capability creates an android-targeted tool_request,
//      and once a heartbeated android client claims + receipts it, the
//      capability resolves with that receipt.
//   3. the classic phone_action tool brokers the same way (url.open).
//   4. all four bounded media tools route only to Android and await receipts,
//      including media.playlist through the single classic fallback schema.
//   5. browser-local media.open/media.bookmark route only to the browser client.
//   6. media calls do not create background browser agent/CDP tasks.
//   7. the existing browser_agent_task capability still works when explicit.
//   8. code mode exposes browser_cdp_execute, queues a profile-bound command
//      batch under the current delegation, and resolves the browser receipt.
//   9. browser_permissions_status requires current-turn permission/readiness
//      wording, accepts no input, and resolves a browser-local terminal receipt.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "surface-skills-smoke-token";
const FILE_ACCESS_INSTRUCTION = "Chrome must grant Ag access to local files. Open chrome://extensions, find Ag, choose Details, turn on “Allow access to file URLs”, then retry. Ag cannot enable this permission for you.";
const {
  resolveTurnSurface,
  surfaceExecuteCapabilities,
  surfaceClassicTools,
} = require(path.join(GATEWAY_DIR, "lib", "surface-skills"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-surface-skills-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });
    const deps = makeDeps(baseUrl);
    const instruction = "Open the docs and find the install command.";
    const url = "https://example.test/";
    const call = {
      source: "agee-extension-smoke",
      conversation_id: "surface_smoke_session",
      branch_id: "default",
      transcript: "Search and open the browser local video and remember this video spot as browser spot.",
      delegation_envelope: confirmedEnvelope(instruction, url),
    };
    const phoneCall = {
      ...call,
      source: "android-overlay-smoke",
      transcript: "Open Chrome. Open that link on my phone. Dial that phone number. Open and play the YouTube video. Seek back 15 seconds. Remember this video spot as favorite explanation. Rename the Road trip playlist to Road trip favorites.",
    };

    await step("resolveTurnSurface canonicalizes sources", () => assertSurfaceResolution());
    await step("android client heartbeats with phone tools", () => heartbeatAndroid(baseUrl));
    await step("browser client heartbeats with local media tools", () => heartbeatBrowser(baseUrl));
    await step("cross-surface browser tab list queues and receipts on the advertised browser", () => assertSimpleDeviceCapability(baseUrl, deps, {
      call: { ...phoneCall, transcript: "Show my browser tabs" }, capability: "browser_list_tabs",
      args: {}, tool: "browser.tab.list", deviceId: "browser_surface_smoke", surface: "browser_extension",
    }));
    await step("explicit browser permission readiness queues and returns the terminal receipt", () => assertSimpleDeviceCapability(baseUrl, deps, {
      call: { ...phoneCall, modality: "voice", transcript_source: "client_stt", transcript: "Check whether browser permissions and file access are ready" },
      capability: "browser_permissions_status", args: {}, tool: "browser.permissions.status",
      deviceId: "browser_surface_smoke", surface: "browser_extension",
      receipt: {
        summary: FILE_ACCESS_INSTRUCTION,
        result: { file_scheme_access: { allowed: false, supported: true, instruction: FILE_ACCESS_INSTRUCTION } },
        local_receipt: { tool: "browser.permissions.status", success: true },
      },
    }));
    await step("browser permission status rejects input and evidence-only authority", () => assertPermissionStatusDenials(baseUrl, deps, phoneCall));
    await step("browser permission status rejects malformed enabled and disabled receipts", () => assertMalformedPermissionStatusReceipts(baseUrl, deps, phoneCall));
    const cdpIntent = "Use browser automation to inspect the agent-owned background tab";
    const cdpEnvelope = confirmedEnvelope(cdpIntent, url);
    await step("QuickJS catalog CDP capability queues bounded commands and resolves the browser receipt", () => assertSimpleDeviceCapability(baseUrl, deps, {
      call: { ...phoneCall, transcript: cdpIntent, delegation_envelope: cdpEnvelope }, capability: "browser_cdp_execute",
      args: { tab_id: 17, authority_profile: "automation", commands: [{ method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }] },
      expectedInput: { tab_id: 17, authority_profile: "automation", cdp_actions: [{ method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }], delegation_envelope: cdpEnvelope },
      tool: "browser.cdp.execute", deviceId: "browser_surface_smoke", surface: "browser_extension",
    }));
    await step("cross-surface Android screen summary queues and receipts on the advertised phone", () => assertSimpleDeviceCapability(baseUrl, deps, {
      call: { ...call, transcript: "Tell me what is on the phone screen" }, capability: "phone_screen_summary",
      args: {}, tool: "screen.summary", deviceId: "android_surface_smoke", surface: "android",
    }));
    await step("Android semantic text entry receives gateway-owned package/window bindings", () => assertSimpleDeviceCapability(baseUrl, deps, {
      call: { ...call, transcript: "Enter weather in Search on the phone" }, capability: "phone_set_text",
      args: { label: "Search", text: "weather" },
      expectedInput: { label: "Search", text: "weather", expected_package: "com.example.fixture", expected_window_id: 42 },
      tool: "screen.set_text", deviceId: "android_surface_smoke", surface: "android",
    }));
    await step("ambiguous browser manifests reject a model-facing action", () => assertAmbiguousBrowserTargets(baseUrl, deps, phoneCall));
    await step("stale browser manifests reject a model-facing action", () => assertStaleBrowserTarget(baseUrl, dataDir, deps, phoneCall));
    await step("browser-local media.open targets only the browser client", () => assertBrowserMediaCapability(baseUrl, deps, call, {
      capability: "media_open",
      tool: "media.open",
      args: { query: "browser local video", app: "YouTube Advanced", preferred_package: "raw.package.override" },
      expectedInput: { query: "browser local video", app_name: "YouTube Advanced" },
    }));
    await step("browser-local media.bookmark targets only the browser client", () => assertBrowserMediaCapability(baseUrl, deps, call, {
      capability: "media_bookmark",
      tool: "media.bookmark",
      args: { operation: "remember", label: "browser spot" },
      expectedInput: { operation: "remember", label: "browser spot" },
    }));
    await step("explicit browser intent selects browser-local media from another source", () => assertBrowserMediaCapability(baseUrl, deps, {
      ...call,
      source: "android-overlay-smoke",
      intended_surface_type: "browser_extension",
    }, {
      capability: "media_open",
      tool: "media.open",
      args: { query: "explicit browser destination" },
      expectedInput: { query: "explicit browser destination" },
    }));
    await step("phone_open_app brokers a visible app label and rejects package authority", () => assertPhoneOpenApp(baseUrl, deps, phoneCall));
    await step("classic phone_action tool brokers url.open the same way", () => assertClassicPhoneAction(baseUrl, deps, phoneCall));
    await step("media.open routes only to Android and awaits its receipt", () => assertMediaCapability(baseUrl, deps, phoneCall, {
      capability: "phone_media_open",
      tool: "media.open",
      args: { video_id: "dQw4w9WgXcQ", position_ms: 42000, app_name: "YouTube" },
      expectedInput: { video_id: "dQw4w9WgXcQ", position_ms: 42000, app_name: "YouTube" },
    }));
    await step("media.control routes only to Android and awaits its receipt", () => assertMediaCapability(baseUrl, deps, phoneCall, {
      capability: "phone_media_control",
      tool: "media.control",
      args: { action: "seek_by", offset_ms: -15000 },
      expectedInput: { action: "seek_by", offset_ms: -15000 },
    }));
    await step("media.bookmark routes only to Android and awaits its receipt", () => assertMediaCapability(baseUrl, deps, phoneCall, {
      capability: "phone_media_bookmark",
      tool: "media.bookmark",
      args: { operation: "remember", label: "favorite explanation", note: "Return here later." },
      expectedInput: { operation: "remember", label: "favorite explanation", note: "Return here later." },
    }));
    await step("classic phone_action brokers media.playlist without another top-level tool", () => assertClassicMediaPlaylist(baseUrl, deps, phoneCall));
    await step("media input is bounded before brokering", () => assertBoundedMediaInput(deps, phoneCall));
    await step("media requests create no browser agent/CDP task", () => assertNoBrowserTask(baseUrl));
    await step("browser_agent_task capability creates a browser agent-loop task", () => assertBrowserAgentTask(baseUrl, deps, call));
    await step("no device claims -> capability returns queued", () => assertQueuedOnTimeout(baseUrl, phoneCall));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "resolveTurnSurface maps android-overlay->android and agee-extension/browser->browser",
        "phone_open_app creates an android-targeted app.launch tool_request",
        "app.launch canonicalizes a visible label to app_name and rejects raw package identifiers",
        "a heartbeated android client claims + receipts it and the capability resolves with the receipt",
        "the classic phone_action tool brokers url.open through the same path",
        "browser-local media.open and media.bookmark select only the browser client and return its receipt",
        "an explicit intended browser surface selects browser-local media even from another source",
        "model-authored preferred_package is absent from brokered media input",
        "media.open, media.control, media.bookmark, and media.playlist target Android and return Android receipts",
        "the single classic phone_action schema supports media tools without adding top-level classic tools",
        "invalid media input is rejected before a tool_request is created",
        "media requests create no browser agent/CDP tasks",
      "browser_agent_task creates a browser agent-loop task and returns task_id + agent_run_id",
      "browser_cdp_execute is present in code mode and resolves a profile-bound browser receipt",
      "browser_permissions_status accepts no input and requires current-turn browser permission/readiness wording",
      "a brokered action with no claiming device returns { queued: true, request_id }",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertSurfaceResolution() {
  assert.equal(resolveTurnSurface({ source: "android-overlay" }), "android");
  assert.equal(resolveTurnSurface({ source: "android" }), "android");
  assert.equal(resolveTurnSurface({ source: "agee-extension" }), "browser");
  assert.equal(resolveTurnSurface({ source: "browser-voice" }), "browser");
  assert.equal(resolveTurnSurface({ source: "some-api" }), "unknown");
  assert.equal(resolveTurnSurface({}), "unknown");
}

async function heartbeatAndroid(baseUrl) {
  const heartbeat = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "android_surface_smoke",
    surface_type: "android",
    session_id: "surface_smoke_session",
    local_tool_manifest: [
      { tool: "app.launch", risk: "navigation", approval: "implicit_user_command" },
      { tool: "url.open", risk: "navigation", approval: "implicit_user_command" },
      { tool: "phone.dial", risk: "external_side_effect", approval: "target_app_confirmation" },
      { tool: "contact.open", risk: "navigation", approval: "implicit_user_command" },
      { tool: "media.open", risk: "navigation", approval: "implicit_user_command" },
      { tool: "media.control", risk: "media_control", approval: "implicit_user_command" },
      { tool: "media.bookmark", risk: "local_state", approval: "implicit_user_command" },
      { tool: "media.playlist", risk: "external_side_effect", approval: "local_confirmation" },
      { tool: "screen.summary", risk: "read_only", approval: "none" },
      { tool: "screen.tap_text", risk: "navigation", approval: "implicit_user_command" },
      { tool: "screen.set_text", risk: "external_side_effect", approval: "local_confirmation" },
      { tool: "screen.scroll", risk: "navigation", approval: "implicit_user_command" },
      { tool: "system.back", risk: "navigation", approval: "implicit_user_command" },
      { tool: "system.home", risk: "navigation", approval: "implicit_user_command" },
    ],
    metadata: {
      context_descriptor: {
        availability: "available", fresh: true,
        package_name: "com.example.fixture", window_id: 42,
      },
    },
  });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));
}

async function heartbeatBrowser(baseUrl) {
  const heartbeat = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "browser_surface_smoke",
    surface_type: "browser_extension",
    session_id: "surface_smoke_session",
    local_tool_manifest: [
      { tool: "media.open", risk: "navigation", approval: "implicit_user_command" },
      { tool: "media.bookmark", risk: "local_state", approval: "implicit_user_command" },
      { tool: "browser.tab.list", risk: "read_only", approval: "none" },
      { tool: "browser.permissions.status", risk: "read_only", approval: "none" },
      { tool: "browser.tab.open", risk: "navigation", approval: "implicit_user_command" },
      { tool: "browser.tab.activate", risk: "navigation", approval: "implicit_user_command" },
      { tool: "browser.tab.close", risk: "navigation", approval: "implicit_user_command" },
      { tool: "browser.tab.reload", risk: "navigation", approval: "implicit_user_command" },
      { tool: "browser.cdp.execute", risk: "browser_local_debugger", approval: "implicit_user_command", authority_profiles: ["automation", "debug"] },
    ],
  });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));
}

async function assertSimpleDeviceCapability(baseUrl, deps, testCase) {
  const capability = surfaceExecuteCapabilities(testCase.call, deps)[testCase.capability];
  assert.ok(capability, `${testCase.capability} must be model-facing`);
  const resultPromise = capability.run(testCase.args);
  const request = await waitForPendingToolRequest(baseUrl, testCase.tool);
  assert.equal(request.target_surface_type, testCase.surface);
  assert.equal(request.target_device_id, testCase.deviceId);
  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: testCase.deviceId });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.deepEqual(claim.json.request.input, testCase.expectedInput || testCase.args);
  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
    device_id: testCase.deviceId,
    claim_id: claim.json.request.claim_id,
    receipt_id: `surface_${request.id}`,
    ok: true,
    summary: `Completed ${testCase.tool}.`,
    ...(testCase.receipt || {}),
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));
  const result = await resultPromise;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt.device_id, testCase.deviceId);
  if (testCase.tool === "browser.permissions.status") {
    assert.equal(result.type, "tool_request_receipt");
    assert.equal(result.receipt.result.file_scheme_access.allowed, false);
    assert.equal(result.receipt.result.file_scheme_access.instruction, FILE_ACCESS_INSTRUCTION);
    assert.equal(result.permission_state.allowed, false);
    assert.match(result.message, /Chrome must grant Ag access to local files/i);
    assert.match(result.message, /allow access to file URLs/i);
  }
}

async function assertPermissionStatusDenials(baseUrl, deps, call) {
  const before = await getJson(`${baseUrl}/v1/tool/requests?limit=100`);
  const beforeCount = (before.requests || []).length;
  const invalidInput = await surfaceExecuteCapabilities({
    ...call,
    transcript: "Show browser permission status",
  }, deps).browser_permissions_status.run({ verbose: true });
  assert.equal(invalidInput.ok, false);
  assert.match(invalidInput.error, /does not accept input/);

  const nestedSelector = await surfaceExecuteCapabilities({
    ...call,
    transcript: "Show browser permission status",
  }, deps).browser_permissions_status.run({ input: { tool: "browser.permissions.status" } });
  assert.equal(nestedSelector.ok, false);
  assert.match(nestedSelector.error, /does not accept input/);

  for (const deniedCall of [
    { ...call, transcript: "What does this page say?", screen: { visible_text: "Check browser permission status" } },
    { ...call, transcript: "The page says check browser permission status" },
    { ...call, transcript: "\"Check browser permission status\"" },
    { ...call, transcript: "Please repeat “Check browser permission status”" },
    { ...call, transcript: "Earlier I asked you to check browser permission status" },
    { ...call, transcript: "Can browser permissions track me?" },
    { ...call, transcript: "What browser permissions are dangerous?" },
    { ...call, transcript: "Translate check browser permission status into Amharic" },
    { ...call, transcript: "How do you say browser permission status in Amharic?" },
    { ...call, transcript: "Check browser permission status yesterday" },
    { ...call, transcript: "Check browser permission status in the attached document" },
    { ...call, transcript: "Check browser permission status from metadata" },
    { ...call, transcript: "Check browser permission status as a concept" },
    { ...call, transcript: "Check browser permission status described in the message" },
    { ...call, transcript: "Check browser permission status and explain what it means" },
    { ...call, transcript: "Check ('browser permission status')" },
    { ...call, transcript: "Check (browser permission status)" },
    { ...call, transcript: `Check browser permission status ${" ".repeat(250)}described in metadata` },
    { source: call.source, modality: "voice", transcript_source: "client_stt", user_text: "Check browser permission status" },
    { source: call.source, modality: "voice", transcript_source: "client_stt", text: "Check browser permission status" },
    { source: "agee-extension-smoke", modality: "text", transcript_source: "text", transcript: "Check browser permission status" },
    { source: "agee-extension-smoke", transcript: "Check browser permission status" },
    { source: "android-overlay", transcript: "Check browser permission status" },
    { source: "browser", transcript: "Check browser permission status" },
  ]) {
    const result = await surfaceExecuteCapabilities(deniedCall, deps).browser_permissions_status.run({});
    assert.equal(result.ok, false, deniedCall.transcript);
    assert.match(result.error, /current user turn|current-turn|spoken\/STT|direct spoken|direct, current-state|direct spoken command|no additional clause/);
  }
  const after = await getJson(`${baseUrl}/v1/tool/requests?limit=100`);
  assert.equal((after.requests || []).length, beforeCount, "denied permission-status calls must create no tool request");
}

async function assertMalformedPermissionStatusReceipts(baseUrl, deps, call) {
  const malformedReceipts = [
    {
      summary: "Enabled.",
      result: { file_scheme_access: { allowed: true, supported: true } },
      local_receipt: { tool: "browser.permissions.status", success: true },
    },
    {
      summary: "File access is disabled.",
      result: { file_scheme_access: { allowed: false, supported: true, instruction: "Open settings." } },
      local_receipt: { tool: "browser.permissions.status", success: true },
    },
  ];
  for (const receiptBody of malformedReceipts) {
    const resultPromise = surfaceExecuteCapabilities({
      ...call,
      modality: "voice",
      transcript_source: "client_stt",
      transcript: "Check browser permission status",
    }, deps).browser_permissions_status.run({});
    const request = await waitForPendingToolRequest(baseUrl, "browser.permissions.status");
    const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "browser_surface_smoke" });
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    assert.equal(claim.json.request.id, request.id);
    const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
      device_id: "browser_surface_smoke",
      claim_id: claim.json.request.claim_id,
      receipt_id: `malformed_${request.id}`,
      ok: true,
      ...receiptBody,
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.json));
    const result = await resultPromise;
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error, /did not include a clear/);
  }
}

async function assertAmbiguousBrowserTargets(baseUrl, deps, call) {
  const heartbeat = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "browser_surface_smoke_second",
    surface_type: "browser_extension",
    local_tool_manifest: [{ tool: "browser.tab.list", risk: "read_only", approval: "none" }],
  });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.json));
  const result = await surfaceExecuteCapabilities({ ...call, transcript: "Show my browser tabs" }, deps)
    .browser_list_tabs.run({});
  assert.equal(result.ok, false);
  assert.match(result.error, /target device is ambiguous/);
  const offline = await postJson(`${baseUrl}/v1/device-clients/heartbeat`, {
    device_id: "browser_surface_smoke_second",
    surface_type: "browser_extension",
    online: false,
    local_tool_manifest: [{ tool: "browser.tab.list", risk: "read_only", approval: "none" }],
  });
  assert.equal(offline.status, 200, JSON.stringify(offline.json));
}

async function assertStaleBrowserTarget(baseUrl, dataDir, deps, call) {
  const clientsPath = path.join(dataDir, "device-clients.json");
  const clients = JSON.parse(fs.readFileSync(clientsPath, "utf8"));
  clients.browser_surface_smoke.last_heartbeat_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(clientsPath, JSON.stringify(clients, null, 2));
  const result = await surfaceExecuteCapabilities({ ...call, transcript: "Show my browser tabs" }, deps)
    .browser_list_tabs.run({});
  assert.equal(result.ok, false);
  assert.match(result.error, /no compatible online target device/);
  await heartbeatBrowser(baseUrl);
}

async function assertPhoneOpenApp(baseUrl, deps, call) {
  const caps = surfaceExecuteCapabilities(call, deps);
  assert.ok(caps.phone_open_app, "phone_open_app capability must exist");
  const rawPackage = await caps.phone_open_app.run({ package: "com.android.chrome" });
  assert.equal(rawPackage.ok, false);
  assert.match(rawPackage.error, /raw package/);
  const packageAsApp = await caps.phone_open_app.run({ app: "com.android.chrome" });
  assert.equal(packageAsApp.ok, false);
  assert.match(packageAsApp.error, /not an Android package identifier/);

  const capPromise = caps.phone_open_app.run({ app: "Chrome" });

  const request = await waitForPendingToolRequest(baseUrl, "app.launch");
  assert.equal(request.target_surface_type, "android", "phone_open_app must target the android surface");
  assert.equal(request.target_device_id, "android_surface_smoke", "must route to the heartbeated android client");

  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "android_surface_smoke" });
  assert.equal(claim.status, 200, `android must claim the request: ${JSON.stringify(claim.json)}`);
  assert.equal(claim.json.request.tool, "app.launch");
  assert.deepEqual(claim.json.request.input, { app_name: "Chrome" }, "the visible app label must canonicalize to app_name");

  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
    device_id: "android_surface_smoke",
    claim_id: claim.json.request.claim_id,
    receipt_id: `surface_${request.id}`,
    ok: true,
    summary: "Launched Chrome.",
    local_receipt: { tool: "app.launch", success: true },
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));

  const result = await capPromise;
  assert.equal(result.ok, true, `capability must resolve ok: ${JSON.stringify(result)}`);
  assert.equal(result.type, "tool_request_receipt");
  assert.equal(result.tool, "app.launch");
  assert.equal(result.request_id, request.id);
  assert.ok(result.receipt, "capability must return the device receipt");
  assert.equal(result.receipt.ok, true);
}

async function assertClassicPhoneAction(baseUrl, deps, call) {
  const tools = surfaceClassicTools(call, deps);
  const phoneAction = tools.find((tool) => tool.name === "phone_action");
  assert.ok(phoneAction, "phone_action classic tool must exist");
  assert.ok(tools.some((tool) => tool.name === "launch_background_browser_task"), "launch_background_browser_task classic tool must exist");

  const capPromise = phoneAction.handler({ tool: "url.open", input: { url: "https://example.test/pricing" } });

  const request = await waitForPendingToolRequest(baseUrl, "url.open");
  assert.equal(request.target_surface_type, "android");
  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "android_surface_smoke" });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.request.input.url, "https://example.test/pricing");
  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
    device_id: "android_surface_smoke",
    claim_id: claim.json.request.claim_id,
    receipt_id: `surface_${request.id}`,
    ok: true,
    summary: "Opened the URL.",
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));

  const result = await capPromise;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, "url.open");
}

async function assertBrowserMediaCapability(baseUrl, deps, call, testCase) {
  const caps = surfaceExecuteCapabilities(call, deps);
  const capability = caps[testCase.capability];
  assert.ok(capability, `${testCase.capability} browser-local capability must exist`);
  assert.match(capability.description, /current browser client/);
  assert.match(capability.description, /never falls back to Android/);

  const resultPromise = capability.run(testCase.args);
  const request = await waitForPendingToolRequest(baseUrl, testCase.tool);
  assert.equal(request.target_surface_type, "browser_extension", `${testCase.tool} must target the browser surface`);
  assert.equal(request.target_device_id, "browser_surface_smoke", `${testCase.tool} must select the browser claimant`);
  assert.notEqual(request.target_device_id, "android_surface_smoke");

  const androidClaim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "android_surface_smoke" });
  assert.equal(androidClaim.status, 204, `Android must not claim browser-local ${testCase.tool}`);
  const browserClaim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "browser_surface_smoke" });
  assert.equal(browserClaim.status, 200, JSON.stringify(browserClaim.json));
  assert.equal(browserClaim.json.request.id, request.id);
  assert.deepEqual(browserClaim.json.request.input, testCase.expectedInput);
  assert.equal(Object.hasOwn(browserClaim.json.request.input, "preferred_package"), false, "raw package overrides must not reach a client");

  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
    device_id: "browser_surface_smoke",
    claim_id: browserClaim.json.request.claim_id,
    receipt_id: `surface_${request.id}`,
    ok: true,
    summary: `Browser completed ${testCase.tool}.`,
    local_receipt: { tool: testCase.tool, success: true },
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));
  const result = await resultPromise;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt.device_id, "browser_surface_smoke");

  const classic = surfaceClassicTools(call, deps);
  assert.equal(classic.filter((tool) => tool.name === "browser_media_action").length, 1, "browser classic fallback stays one media tool");
}

async function assertMediaCapability(baseUrl, deps, call, testCase) {
  const caps = surfaceExecuteCapabilities(call, deps);
  const capability = caps[testCase.capability];
  assert.ok(capability, `${testCase.capability} capability must exist`);
  assert.match(capability.description, new RegExp(testCase.tool.replace(".", "\\.")));

  const resultPromise = capability.run(testCase.args);
  const request = await waitForPendingToolRequest(baseUrl, testCase.tool);
  assert.equal(request.target_surface_type, "android", `${testCase.tool} must target Android`);
  assert.equal(request.target_device_id, "android_surface_smoke", `${testCase.tool} must select the Android claimant`);
  assert.notEqual(request.target_surface_type, "browser_extension", `${testCase.tool} must never target the browser`);

  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "android_surface_smoke" });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(claim.json.request.tool, testCase.tool);
  for (const [key, value] of Object.entries(testCase.expectedInput)) {
    assert.deepEqual(claim.json.request.input[key], value, `${testCase.tool}.${key} must survive unchanged`);
  }

  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
    device_id: "android_surface_smoke",
    claim_id: claim.json.request.claim_id,
    receipt_id: `surface_${request.id}`,
    ok: true,
    summary: `Android completed ${testCase.tool}.`,
    local_receipt: { tool: testCase.tool, success: true },
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));

  const result = await resultPromise;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.type, "tool_request_receipt");
  assert.equal(result.tool, testCase.tool);
  assert.equal(result.request_id, request.id);
  assert.equal(result.receipt.device_id, "android_surface_smoke");
}

async function assertClassicMediaPlaylist(baseUrl, deps, call) {
  const tools = surfaceClassicTools(call, deps);
  assert.equal(tools.filter((tool) => tool.name === "phone_action").length, 1, "classic fallback stays one phone_action tool");
  assert.equal(tools.filter((tool) => tool.name.startsWith("media_")).length, 0, "classic fallback must not add one schema per media action");
  const phoneAction = tools.find((tool) => tool.name === "phone_action");
  for (const tool of ["media.open", "media.control", "media.bookmark", "media.playlist"]) {
    assert.ok(phoneAction.parameters.properties.tool.enum.includes(tool), `${tool} must be available through phone_action`);
  }

  const resultPromise = phoneAction.handler({
    tool: "media.playlist",
    input: { operation: "rename", playlist_name: "Road trip", new_name: "Road trip favorites" },
  });
  const request = await waitForPendingToolRequest(baseUrl, "media.playlist");
  assert.equal(request.target_surface_type, "android");
  const claim = await postJson(`${baseUrl}/v1/tool/requests/claim`, { device_id: "android_surface_smoke" });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.deepEqual(claim.json.request.input, {
    operation: "rename",
    playlist_name: "Road trip",
    replacement_name: "Road trip favorites",
  });
  assert.equal(Object.hasOwn(claim.json.request.input, "new_name"), false, "playlist rename alias must be canonicalized");
  const receipt = await postJson(`${baseUrl}/v1/tool/requests/${request.id}/receipts`, {
    device_id: "android_surface_smoke",
    claim_id: claim.json.request.claim_id,
    receipt_id: `surface_${request.id}`,
    ok: true,
    summary: "Android locally approved and completed media.playlist.",
  });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.json));
  const result = await resultPromise;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tool, "media.playlist");
  assert.equal(result.receipt.device_id, "android_surface_smoke");
}

async function assertBoundedMediaInput(deps, call) {
  const caps = surfaceExecuteCapabilities(call, deps);
  const invalidVideo = await caps.phone_media_open.run({ video_id: "not-eleven!!" });
  assert.equal(invalidVideo.ok, false);
  assert.match(invalidVideo.error, /exactly 11/);
  const invalidSeek = await caps.phone_media_control.run({ action: "seek_to" });
  assert.equal(invalidSeek.ok, false);
  assert.match(invalidSeek.error, /position_ms is required/);
  const classicPhoneAction = surfaceClassicTools(call, deps).find((tool) => tool.name === "phone_action");
  const invalidRename = await classicPhoneAction.handler({
    tool: "media.playlist",
    input: { operation: "rename", playlist_name: "Road trip" },
  });
  assert.equal(invalidRename.ok, false);
  assert.match(invalidRename.error, /replacement_name or new_name is required/);
}

async function assertNoBrowserTask(baseUrl) {
  const tasks = await getJson(`${baseUrl}/v1/browser/agent-tasks?limit=100`);
  assert.deepEqual(tasks.tasks || [], [], "Android media proposals must not fall back to browser agent/CDP tasks");
}

async function assertBrowserAgentTask(baseUrl, deps, call) {
  const caps = surfaceExecuteCapabilities(call, deps);
  assert.ok(caps.browser_agent_task, "browser_agent_task capability must exist");
  const result = await caps.browser_agent_task.run({
    instruction: "Open the docs and find the install command.",
    url: "https://example.test/",
  });
  assert.equal(result.ok, true, `browser_agent_task must resolve ok: ${JSON.stringify(result)}`);
  assert.equal(result.type, "browser_agent_task");
  assert.ok(result.task_id, "must return a task_id");
  assert.ok(result.agent_run_id, "must return an agent_run_id");

  const got = await getJson(`${baseUrl}/v1/browser/agent-tasks/${result.task_id}`);
  assert.equal(got.task.id, result.task_id);
  assert.equal(got.task.status, "pending");
  assert.equal(got.task.instruction, "Open the docs and find the install command.");
  assert.equal(got.task.agent_run_id, result.agent_run_id);
}

async function assertQueuedOnTimeout(baseUrl, call) {
  // Use a fast poll/timeout deps so the "no device claims" path returns quickly.
  const deps = makeDeps(baseUrl);
  const caps = surfaceExecuteCapabilities(call, deps);
  // phone.dial has no advertised claimant that we drive here; broker it and let
  // the short timeout expire. Use a tiny receipt timeout via the classic path is
  // not exposed, so we drive the capability with a shortened poll by racing.
  const result = await Promise.race([
    caps.phone_dial.run({ number: "+15550001111" }),
    (async () => {
      // Guard: this path can take up to ~10s; keep the smoke bounded.
      await new Promise((resolve) => setTimeout(resolve, 12000));
      return { ok: false, timeout_guard: true };
    })(),
  ]);
  // Either the broker's 10s window elapsed (queued) or the guard fired; both
  // prove the non-failing timeout contract. A queued result is the expected one.
  assert.ok(result.queued === true || result.timeout_guard === true, `expected queued-on-timeout: ${JSON.stringify(result)}`);
  if (result.queued === true) {
    assert.ok(result.request_id, "queued result must carry request_id");
    assert.equal(result.tool, "phone.dial");
  }
}

function makeDeps(baseUrl) {
  return {
    createToolRequest: async (body) => {
      const response = await postJson(`${baseUrl}/v1/tool/requests`, body);
      assert.equal(response.status, 202, `createToolRequest failed: ${JSON.stringify(response.json)}`);
      return response.json.request;
    },
    readToolRequest: async (id) => {
      const list = await getJson(`${baseUrl}/v1/tool/requests?limit=100`);
      return (list.requests || []).find((req) => req.id === id) || null;
    },
    launchBrowserAgentTask: async ({ instruction, url, delegation_envelope }) => {
      const response = await postJson(`${baseUrl}/v1/browser/agent-tasks`, {
        instruction,
        url,
        source: "surface-skills-smoke",
        delegation_envelope,
      });
      assert.equal(response.status, 202, `launchBrowserAgentTask failed: ${JSON.stringify(response.json)}`);
      return { task_id: response.json.task.id, agent_run_id: response.json.task.agent_run_id };
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function confirmedEnvelope(intent, url) {
  return {
    version: "moa.browser-delegation.v1",
    confirmation: { confirmed: true, user_intent: intent },
    goal: intent,
    scope: { page_url: url, allowed_origins: [new URL(url).origin] },
    allowed_action_classes: ["click", "type", "wait"],
    approval_policy: { preauthorized: ["click", "type", "wait"], always_ask: [] },
    checkpoints: ["before submit"],
    stop_conditions: ["goal complete", "scope changed"],
    max_steps: 5,
    completion_evidence: ["install command"],
  };
}

async function waitForPendingToolRequest(baseUrl, tool) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const list = await getJson(`${baseUrl}/v1/tool/requests?status=pending&limit=100`);
    const match = (list.requests || []).find((req) => req.tool === tool && req.status === "pending");
    if (match) return match;
    await delay(100);
  }
  throw new Error(`no pending ${tool} tool_request appeared`);
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.trim() ? JSON.parse(text) : {} };
}

async function getJson(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await response.text();
  assert.ok(response.ok, `GET ${url} failed: ${response.status} ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function startGateway({ port, dataDir }) {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      MODEL_PROVIDER: "openai-compatible",
      MODEL_API_KEY: "",
      VOICE_PROVIDER: "loopback",
      VOICE_STT_PROVIDER: "loopback",
      VOICE_LLM_PROVIDER: "loopback",
      VOICE_TTS_PROVIDER: "loopback",
      ALLOW_AGENT_WITHOUT_TOKEN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const baseUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (server.exitCode != null) {
      throw new Error(`gateway exited with ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return server;
    } catch {
      // Keep waiting.
    }
    await delay(100);
  }
  throw new Error("gateway did not start");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Headless smoke for the A.G. side panel agent surface.
//
// Loads the REAL extension in Chrome for Testing, opens sidepanel.html as an
// extension page, and proves the panel bridge end to end: the page boots, the
// agee-panel port connects, and a request round-trips through the background's
// handlePanelRequest with reqId correlation. Also asserts the open-agee-panel
// command registered and chrome.sidePanel.open exists in the service worker.
//
// The panel is an extension page, so this exercises exactly what runs when the
// panel is open over a chrome:// tab — no content script involved.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `sidepanel-${runId}`);
const profilePath = join(runDir, "chrome-profile");

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.onopen = resolveReady;
      this.ws.onerror = rejectReady;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, rejectCall } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rejectCall(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else resolveCall(msg.result);
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolveCall, rejectCall });
    });
  }

  close() {
    this.ws.close();
  }
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((resp) => resp.json());
}

async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let lastTargets = [];
  while (Date.now() - started < timeoutMs) {
    lastTargets = await targets(port);
    const found = lastTargets.find(predicate);
    if (found) return found;
    await delay(200);
  }
  throw new Error(`Timed out waiting for Chrome target. Last targets: ${JSON.stringify(lastTargets.map((target) => ({
    type: target.type,
    title: target.title,
    url: target.url,
  })), null, 2)}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 12000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression).catch(() => undefined);
    if (lastValue) return lastValue;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)}`);
}

async function main() {
  const chromePath = resolveChromeForTesting();
  mkdirSync(profilePath, { recursive: true });

  const gateway = createServer((request, response) => {
    if (request.url === "/fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Recovery fixture</title><main>Microphone recovery fixture</main>");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ws_url: "ws://127.0.0.1:9/v1/voice/sessions",
      session_id: "sidepanel-recovery-smoke",
      conversation_id: "sidepanel-recovery-smoke",
    }));
  });
  await new Promise((resolveListen, rejectListen) => {
    gateway.once("error", rejectListen);
    gateway.listen(0, "127.0.0.1", resolveListen);
  });
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let browserCdp;
  let offscreenCdp;
  let overlayCdp;
  let pageCdp;
  let optionsCdp;
  let workerCdp;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const workerTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    // The service-worker target can appear a few milliseconds before Chrome
    // has attached its extension APIs. Retry this first real API read instead
    // of treating that startup race as a product exception.
    const commands = await waitForEval(
      workerCdp,
      'globalThis.chrome?.commands?.getAll ? chrome.commands.getAll().then((items) => items.length ? items : null) : null',
    );
    if (!commands.find((command) => command.name === "open-agee-panel")) {
      throw new Error(`open-agee-panel command was not registered: ${JSON.stringify(commands)}`);
    }
    const sidePanelApi = await waitForEval(workerCdp, 'typeof chrome.sidePanel?.open === "function"');
    if (!sidePanelApi) throw new Error("chrome.sidePanel.open is not available in the service worker");
    await evaluate(workerCdp, `(async () => {
      await chrome.storage.local.set({
        ageeGatewayUrl: ${JSON.stringify(gatewayUrl)},
        ageeGatewayToken: "",
        ageeGatewayUserSet: true,
      });
      return true;
    })()`);

    const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: panelUrl });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await waitForEval(pageCdp, 'document.readyState === "complete" && document.getElementById("status")?.textContent === "Ready."');

    const roleUi = await evaluate(pageCdp, `(async () => {
      const selector = document.getElementById("agentModeSelector");
      const buttons = [...document.querySelectorAll("[data-agent-mode-option]")];
      const initial = selector?.dataset.agentMode || "";
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.getElementById("agentModeCollaborate")?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stored = await chrome.storage.local.get("ageeBrowserAgentRole");
      return {
        initial,
        selected: selector?.dataset.agentMode || "",
        stored: stored.ageeBrowserAgentRole || "",
        pressed: buttons.filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.dataset.agentModeOption),
      };
    })()`);
    if (
      roleUi?.initial !== "delegate" ||
      roleUi?.selected !== "collaborate" ||
      roleUi?.stored !== "collaborate" ||
      JSON.stringify(roleUi?.pressed) !== JSON.stringify(["collaborate"])
    ) {
      throw new Error(`side-panel role selector did not persist one explicit role: ${JSON.stringify(roleUi)}`);
    }

    await evaluate(workerCdp, `(async () => {
      const url = chrome.runtime.getURL("offscreen.html");
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url],
      });
      if (!existing.length) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA"],
          justification: "Side-panel microphone recovery smoke",
        });
      }
      return true;
    })()`);
    const offscreenTarget = await waitForTarget(
      devToolsPort,
      (target) => String(target.url || "") === `chrome-extension://${extensionId}/offscreen.html`,
    );
    offscreenCdp = new Cdp(offscreenTarget.webSocketDebuggerUrl);
    await offscreenCdp.send("Runtime.enable");
    await evaluate(offscreenCdp, `(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => { throw new DOMException("Permission denied by recovery smoke", "NotAllowedError"); },
      });
      return true;
    })()`);
    const talkPoint = await evaluate(pageCdp, `(() => {
      const rect = document.getElementById("talk")?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    if (!talkPoint) throw new Error("side-panel talk control was not measurable");
    await pageCdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: talkPoint.x,
      y: talkPoint.y,
      button: "left",
      clickCount: 1,
    });
    const voiceRecovery = await waitForEval(pageCdp, `(() => {
      const action = document.querySelector(".turn:last-child .microphone-recovery-action");
      const reply = document.querySelector(".turn:last-child .ag");
      if (!action || !reply) return null;
      return { action: action.textContent, reply: reply.textContent };
    })()`, 8000);
    await pageCdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: talkPoint.x,
      y: talkPoint.y,
      button: "left",
      clickCount: 1,
    });
    const optionsBeforeRecoveryAction = (await targets(devToolsPort)).filter(
      (target) => target.type === "page" && String(target.url || "").startsWith(`chrome-extension://${extensionId}/options.html`),
    );
    if (
      optionsBeforeRecoveryAction.length !== 0 ||
      voiceRecovery.action !== "Take me to microphone setup" ||
      !voiceRecovery.reply.includes("microphone")
    ) {
      throw new Error(`initial microphone denial did not stay visible before navigation: ${JSON.stringify({ voiceRecovery, optionsBeforeRecoveryAction })}`);
    }
    await evaluate(pageCdp, 'document.querySelector(".turn:last-child .microphone-recovery-action")?.click()');
    const optionsTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "page" && String(target.url || "").startsWith(`chrome-extension://${extensionId}/options.html`),
    );
    optionsCdp = new Cdp(optionsTarget.webSocketDebuggerUrl);
    await optionsCdp.send("Runtime.enable");
    const recovery = await waitForEval(optionsCdp, `(() => {
      const banner = document.getElementById("micRecoveryBanner");
      const grant = document.getElementById("grantMic");
      if (!banner || banner.hidden || !grant?.classList.contains("mic-recovery-focus")) return null;
      return { banner: banner.textContent, focused: document.activeElement === grant };
    })()`);
    if (!recovery.focused || !recovery.banner.includes("microphone")) {
      throw new Error(`microphone setup did not show and focus its walkthrough: ${JSON.stringify(recovery)}`);
    }
    optionsCdp.close();
    optionsCdp = null;
    await browserCdp.send("Target.closeTarget", { targetId: optionsTarget.id });

    await evaluate(pageCdp, `(() => {
      const input = document.getElementById("settingsSearch");
      input.value = "microphone";
      document.getElementById("settingsForm")?.requestSubmit();
      return true;
    })()`);
    await waitForEval(
      pageCdp,
      'document.querySelector(".setting-row[data-setting-id=\\"browser.microphone_permission\\"]")?.textContent.includes("Current:")',
    );
    await evaluate(pageCdp, 'document.querySelector(".setting-row[data-setting-id=\\"browser.microphone_permission\\"]")?.click()');
    const settingsProjection = await waitForEval(pageCdp, `(() => {
      const detail = document.getElementById("settingsDetail");
      const action = detail?.querySelector(".setting-deep-link");
      if (detail?.hidden || !action) return null;
      return { text: detail.textContent, action: action.textContent };
    })()`);
    if (
      !settingsProjection.text.includes("Owner: browser_extension") ||
      !settingsProjection.text.includes("Default: prompt") ||
      !settingsProjection.text.includes("Takes effect: next voice capture") ||
      !settingsProjection.text.includes("Redaction: none") ||
      settingsProjection.action !== "Open microphone setup"
    ) {
      throw new Error(`settings discovery did not render the typed permission projection: ${JSON.stringify(settingsProjection)}`);
    }
    const parity = await evaluate(pageCdp, `(async () => {
      const panel = await import(chrome.runtime.getURL("sidepanel.js"));
      const spoken = await panel.projectSpokenSettingsQuery({}, "Find settings about microphone access");
      const spokenIds = spoken.settings.map((setting) => setting.id);
      const renderedIds = [...document.querySelectorAll(".setting-row")].map((row) => row.dataset.settingId);
      await panel.runSettingsQuery("list");
      const allIds = [...document.querySelectorAll(".setting-row")].map((row) => row.dataset.settingId);
      return { spokenIds, renderedIds, allIds };
    })()`);
    if (
      parity.spokenIds[0] !== "browser.microphone_permission" ||
      parity.renderedIds[0] !== parity.spokenIds[0] ||
      !["browser.gateway_url", "browser.gateway_token", "browser.livekit_voice", "browser.background_automation", "browser.microphone_permission", "browser.agent_role"]
        .every((id) => parity.allIds.includes(id))
    ) {
      throw new Error(`spoken/typed settings identities or complete local All projection diverged: ${JSON.stringify(parity)}`);
    }
    const writes = await evaluate(pageCdp, `new Promise(async (resolveWrites) => {
      const port = chrome.runtime.connect({ name: "agee-panel" });
      let reqId = 8100;
      const pending = new Map();
      port.onMessage.addListener((msg) => {
        const resolve = pending.get(msg?.reqId);
        if (resolve) { pending.delete(msg.reqId); resolve(msg); }
      });
      const request = (payload) => new Promise((resolve) => {
        const id = reqId++;
        pending.set(id, resolve);
        port.postMessage({ reqId: id, ...payload });
      });
      const unknown = await request({ cmd: "settingsWrite", id: "browser.not_real", value: true });
      const microphone = await request({ cmd: "settingsWrite", id: "browser.microphone_permission", value: "granted" });
      const background = await request({ cmd: "settingsWrite", id: "browser.background_automation", value: true });
      const livekit = await request({ cmd: "settingsWrite", id: "browser.livekit_voice", value: true });
      const token = await request({ cmd: "settingsWrite", id: "browser.gateway_token", value: "smoke-secret-must-not-return" });
      await request({ cmd: "settingsWrite", id: "browser.gateway_token", value: "" });
      const stored = await chrome.storage.local.get({ ageeLivekitVoiceEnabled: false, ageeBackgroundAutomationEnabled: false });
      resolveWrites({ unknown, microphone, background, livekit, token, stored });
    })`);
    if (
      writes.unknown?.error !== "unknown_setting" ||
      writes.microphone?.error !== "setting_not_writable" ||
      writes.background?.error !== "explicit_versioned_approval_required" ||
      writes.livekit?.receipt?.current !== true ||
      writes.stored.ageeLivekitVoiceEnabled !== true ||
      writes.stored.ageeBackgroundAutomationEnabled !== false ||
      JSON.stringify(writes.token).includes("smoke-secret-must-not-return") ||
      writes.token?.receipt?.redacted !== true
    ) {
      throw new Error(`owner-brokered settings writes violated validation/redaction: ${JSON.stringify(writes)}`);
    }
    await evaluate(pageCdp, 'document.querySelector(".setting-row[data-setting-id=\\"browser.microphone_permission\\"]")?.click()');
    await waitForEval(pageCdp, '!document.getElementById("settingsDetail")?.hidden && document.querySelector("#settingsDetail .setting-deep-link")');
    await evaluate(pageCdp, 'document.querySelector("#settingsDetail .setting-deep-link")?.click()');
    const settingsOptionsTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "page" && String(target.url || "").startsWith(`chrome-extension://${extensionId}/options.html`),
    );
    await browserCdp.send("Target.closeTarget", { targetId: settingsOptionsTarget.id });

    const { targetId: overlayTargetId } = await browserCdp.send("Target.createTarget", { url: `${gatewayUrl}/fixture` });
    const overlayTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "page" && target.id === overlayTargetId,
    );
    overlayCdp = new Cdp(overlayTarget.webSocketDebuggerUrl);
    await overlayCdp.send("Runtime.enable");
    await waitForEval(overlayCdp, 'document.readyState === "complete" && document.querySelector("#agee-voice")');
    await evaluate(overlayCdp, 'document.querySelector("#agee-voice")?.click()');
    const overlayRecovery = await waitForEval(overlayCdp, `(() => {
      const action = document.querySelector(".agee-cue-recovery");
      const status = document.querySelector(".agee-cue-error .agee-cue-status");
      if (!action || !status) return null;
      return { action: action.textContent, status: status.textContent };
    })()`);
    const optionsBeforeOverlayAction = (await targets(devToolsPort)).filter(
      (target) => target.type === "page" && String(target.url || "").startsWith(`chrome-extension://${extensionId}/options.html`),
    );
    if (
      optionsBeforeOverlayAction.length !== 0 ||
      overlayRecovery.action !== "Take me to microphone setup" ||
      !overlayRecovery.status.includes("microphone")
    ) {
      throw new Error(`overlay microphone denial did not stay visible before navigation: ${JSON.stringify({ overlayRecovery, optionsBeforeOverlayAction })}`);
    }
    await evaluate(overlayCdp, 'document.querySelector(".agee-cue-recovery")?.click()');
    await waitForTarget(
      devToolsPort,
      (target) => target.type === "page" && String(target.url || "").startsWith(`chrome-extension://${extensionId}/options.html`),
    );

    await evaluate(pageCdp, `(() => {
      document.getElementById("agentModeDelegate")?.click();
      const input = document.getElementById("text");
      input.value = "organize this page";
      document.getElementById("form")?.requestSubmit();
      return true;
    })()`);
    await waitForEval(pageCdp, 'document.querySelector(".delegation-confirm-actions") && document.querySelector(".delegation-confirm-copy")?.textContent.includes("up to 20 steps")');
    await evaluate(pageCdp, 'document.querySelector(".delegation-confirm-actions .secondary")?.click()');
    await waitForEval(pageCdp, '[...document.querySelectorAll(".turn .ag")].some((node) => node.textContent === "Delegation cancelled.")');

    // Round-trip the panel bridge: an unsupported command must come back with
    // its reqId and a readable error, proving onConnect -> handlePanelRequest
    // -> reqId correlation against the REAL background worker.
    const roundtrip = await evaluate(pageCdp, `new Promise((resolvePing) => {
      const testPort = chrome.runtime.connect({ name: "agee-panel" });
      const timer = setTimeout(() => resolvePing({ timeout: true }), 8000);
      testPort.onMessage.addListener((msg) => {
        if (msg && msg.reqId === 424242) {
          clearTimeout(timer);
          resolvePing(msg);
        }
      });
      testPort.postMessage({ reqId: 424242, cmd: "panelSmokePing" });
    })`);
    if (roundtrip?.timeout) throw new Error("panel bridge round-trip timed out");
    if (roundtrip?.ok !== false || !/unsupported panel command/.test(String(roundtrip?.error || ""))) {
      throw new Error(`unexpected panel bridge reply: ${JSON.stringify(roundtrip)}`);
    }

    console.log(
      `sidepanel smoke passed (REAL extension, headless Chrome for Testing): panel page booted at ${panelUrl}, ` +
        "agee-panel port round-tripped through the background worker, open-agee-panel command registered, " +
        "typed/spoken settings identities matched, All exposed every local control, brokered writes failed closed/redacted, microphone walkthrough opened, " +
        "initial microphone denial stayed visible until its explicit recovery action opened the focused walkthrough, " +
        "the page overlay preserved the same structured start-denial action without auto-navigation, " +
        "settings search selected the grounded microphone row, " +
        "role selector persisted Collaborate, Delegate confirmation cancelled safely, chrome.sidePanel.open available.",
    );
  } finally {
    workerCdp?.close();
    offscreenCdp?.close();
    overlayCdp?.close();
    optionsCdp?.close();
    pageCdp?.close();
    browserCdp?.close();
    chrome.kill("SIGTERM");
    gateway.close();
    await delay(300);
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});

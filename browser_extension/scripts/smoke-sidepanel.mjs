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

  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let browserCdp;
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

    const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: panelUrl });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await waitForEval(pageCdp, 'document.readyState === "complete" && document.getElementById("status")?.textContent === "Ready."');

    const roleUi = await evaluate(pageCdp, `(() => ({
      selectors: document.querySelectorAll("#agentModeSelector, [data-agent-mode-option]").length,
      roles: [roleForInstruction("explain this"), roleForInstruction("help me do this"),
        roleForInstruction("work with me"), roleForInstruction("organize this page")],
    }))()`);
    if (roleUi?.selectors !== 0 || JSON.stringify(roleUi?.roles) !== JSON.stringify(["explain", "help", "collaborate", "delegate"])) {
      throw new Error(`side-panel conversational roles are not selector-free: ${JSON.stringify(roleUi)}`);
    }

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
    await evaluate(pageCdp, 'document.querySelector("#settingsDetail .setting-deep-link")?.click()');
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

    await evaluate(pageCdp, `(() => {
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
        "settings search selected the grounded microphone row and opened its focused walkthrough, " +
        "conversational roles had no selector, Delegate confirmation cancelled safely, chrome.sidePanel.open available.",
    );
  } finally {
    workerCdp?.close();
    optionsCdp?.close();
    pageCdp?.close();
    browserCdp?.close();
    chrome.kill("SIGTERM");
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

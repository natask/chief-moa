// Isolated real-Chrome proof for the opt-in userScripts executor. This uses a
// throwaway Chrome for Testing profile, toggles Allow User Scripts through the
// trusted chrome://extensions details UI, then proves execute, registration
// read-back, page effect, and verified removal. It never touches a daily profile.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `user-scripts-${runId}`);
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
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "evaluation failed");
  }
  return response.result.value;
}

async function waitForValue(cdp, expression, timeoutMs = 12000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(cdp, expression).catch(() => null);
    if (last) return last;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(last)}`);
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
}

async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = (await targets(port)).find(predicate);
    if (target) return target;
    await delay(150);
  }
  throw new Error("Timed out waiting for Chrome target");
}

async function waitForAgeeWorker(port, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const candidates = (await targets(port)).filter(
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );
    for (const target of candidates) {
      const candidate = new Cdp(target.webSocketDebuggerUrl);
      try {
        await candidate.send("Runtime.enable");
        const manifest = await evaluate(candidate, `(() => {
          try {
            const value = globalThis.chrome?.runtime?.getManifest?.();
            return value?.name === "Ag" && value.permissions?.includes("userScripts") ? value : null;
          } catch {
            return null;
          }
        })()`);
        if (manifest) return { target, worker: candidate };
      } catch {
        // A component worker or a worker that restarted while CDP attached.
      }
      candidate.close();
    }
    await delay(150);
  }
  throw new Error("Timed out waiting for the AG extension service worker");
}

async function probe(worker) {
  return evaluate(worker, `(async () => {
    const methods = ["getScripts", "execute", "register", "update", "unregister"];
    const detected = Object.fromEntries(methods.map((name) => [name, typeof chrome?.userScripts?.[name]]));
    if (!globalThis.chrome?.userScripts || methods.some((name) => detected[name] !== "function")) {
      const major = Number((navigator.userAgent.split("Chrome/")[1] || navigator.userAgent.split("Chromium/")[1] || "").split(".")[0]);
      const declared = chrome.runtime.getManifest().permissions.includes("userScripts");
      return { state: declared && major >= 135 && !globalThis.chrome?.userScripts ? "chrome_toggle_required" : "unsupported", detected, major };
    }
    try {
      await chrome.userScripts.getScripts();
      return { state: "available" };
    } catch {
      return { state: "chrome_toggle_required" };
    }
  })()`);
}

async function main() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>userScripts smoke</title><main>fixture</main>");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  mkdirSync(profilePath, { recursive: true });
  const chrome = spawn(resolveChromeForTesting(), quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  let browser;
  let worker;
  let page;
  let details;
  let runtimePage;
  try {
    const port = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const { target: workerTarget, worker: ageeWorker } = await waitForAgeeWorker(port);
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];
    worker = ageeWorker;

    const browserInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
    browser = new Cdp(browserInfo.webSocketDebuggerUrl);
    const pageTargetId = (await browser.send("Target.createTarget", { url: fixtureUrl })).targetId;
    const pageTarget = await waitForTarget(port, (target) => target.id === pageTargetId);
    page = new Cdp(pageTarget.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await waitForValue(page, "document.readyState === 'complete'");

    let state = await probe(worker);
    if (state.state === "chrome_toggle_required") {
      const detailsTargetId = (await browser.send("Target.createTarget", {
        url: `chrome://extensions/?id=${extensionId}`,
      })).targetId;
      const detailsTarget = await waitForTarget(port, (target) => target.id === detailsTargetId);
      details = new Cdp(detailsTarget.webSocketDebuggerUrl);
      await details.send("Runtime.enable");
      const clicked = await waitForValue(details, `(() => {
        const manager = document.querySelector("extensions-manager");
        const view = manager?.shadowRoot?.querySelector("extensions-detail-view");
        const toggle = view?.shadowRoot?.querySelector("#allow-user-scripts");
        if (!toggle) return null;
        if (!toggle.checked) toggle.getLabel().click();
        return true;
      })()`);
      if (!clicked) throw new Error("Chrome user-scripts toggle was not reachable in the isolated extension details UI");
      const started = Date.now();
      while (Date.now() - started < 10000) {
        state = await probe(worker);
        if (state.state === "available") break;
        await delay(200);
      }
    }
    if (state.state !== "available") throw new Error(`real Chrome userScripts unavailable after isolated toggle attempt: ${JSON.stringify(state)}`);

    const runtimeTargetId = (await browser.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options.html`,
    })).targetId;
    const runtimeTarget = await waitForTarget(port, (target) => target.id === runtimeTargetId);
    runtimePage = new Cdp(runtimeTarget.webSocketDebuggerUrl);
    await runtimePage.send("Runtime.enable");
    await waitForValue(runtimePage, "document.readyState === 'complete'");

    const tabId = await evaluate(runtimePage, `(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === ${JSON.stringify(fixtureUrl)})?.id || null;
    })()`);
    if (!Number.isInteger(tabId)) throw new Error("fixture tab id unavailable");
    const result = await evaluate(runtimePage, `(async () => {
      const runtimeModule = await import(chrome.runtime.getURL("user-scripts-runtime.js"));
      const injectedModule = await import(chrome.runtime.getURL("browser-injected-tool-runtime.js"));
      await chrome.storage.local.set({ ageeReviewedUserScriptsEnabled: true, ageeDelegatedUserScriptsEnabled: true });
      const runtime = runtimeModule.createUserScriptsRuntime({ chromeApi: chrome, chromeMajor: 143 });
      const injectedRuntime = injectedModule.createBrowserInjectedToolRuntime({ chromeApi: chrome });
      const documentProbe = await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => null });
      const documentId = documentProbe[0]?.documentId;
      if (!documentId) throw new Error("fixture document id unavailable");
      async function reviewedProgram(artifactId, revision, source, mode, target) {
        const program = {
          schema: "moa.browser-program.v2",
          artifact_id: artifactId,
          revision,
          source,
          source_sha256: await runtimeModule.sourceDigest(source),
          mode,
          world: "USER_SCRIPT",
          run_at: "document_idle",
          target,
          authority: null,
        };
        program.authority = {
          profile: runtimeModule.REVIEWED_PROFILE,
          standalone: {
            approval_id: "approval-" + artifactId,
            approved_source_sha256: program.source_sha256,
            approved_scope_digest: await runtimeModule.programScopeDigest(program),
          },
        };
        return program;
      }
      function approval(program) {
        return { approval: {
          approval_id: program.authority.standalone.approval_id,
          source_sha256: program.source_sha256,
          scope_digest: program.authority.standalone.approved_scope_digest,
          current: true,
        } };
      }
      const immediate = await reviewedProgram(
        "real-smoke-immediate",
        1,
        "document.documentElement.dataset.moaUserScriptsImmediate = 'yes';",
        "immediate",
        {
          tab_id: ${tabId}, document_id: documentId, frame_scope: "top",
          origins: [${JSON.stringify(`http://127.0.0.1:${server.address().port}`)}], matches: [], excludes: [],
        },
      );
      const persistent = await reviewedProgram(
        "real-smoke-persistent",
        1,
        "document.documentElement.dataset.moaUserScriptsRegistered = 'yes';",
        "persistent",
        {
          tab_id: null, document_id: null, frame_scope: "top",
          origins: [${JSON.stringify(`http://127.0.0.1:${server.address().port}`)}],
          matches: [${JSON.stringify(`http://127.0.0.1:${server.address().port}/*`)}], excludes: [],
        },
      );
      const executed = await runtime.execute(immediate, approval(immediate));
      const registered = await runtime.register(persistent, approval(persistent));
      const installedTool = await injectedRuntime.save({
        schema: "moa.browser-injected-tool.v1",
        name: "real_smoke_tool",
        description: "Return a bounded marker from the fixture page.",
        effect: "read",
        matches: [${JSON.stringify(`http://127.0.0.1:${server.address().port}/*`)}],
        input_schema: { type: "object", properties: { marker: { type: "string", maxLength: 16 } }, required: ["marker"], additionalProperties: false },
        source: "async (input) => ({ marker: input.marker, title: document.title })",
      });
      const injected = await injectedRuntime.execute(installedTool.tool, { tab_id: ${tabId}, arguments: { marker: "installed" } });
      globalThis.__moaUserScriptsSmoke = { runtime, persistent, injectedRuntime, installedTool };
      const stored = await chrome.storage.local.get(["ageeUserScriptExecutionHistory", "ageeUserScriptPrograms"]);
      return {
        executeStatus: executed.status,
        registerStatus: registered.status,
        registrationId: registered.registration?.id,
        immediateHasActiveRegistration: stored.ageeUserScriptExecutionHistory?.[0]?.active_registration !== undefined,
        persistentActiveRevision: stored.ageeUserScriptPrograms?.moa_real_smoke_persistent?.active_registration?.revision,
        injectedTool: injected.result,
        injectedSourceBound: injected.local_receipt?.source_sha256 === installedTool.source_sha256,
      };
    })()`);
    if (
      result.executeStatus !== "succeeded" || result.registerStatus !== "succeeded" ||
      result.registrationId !== "moa_real_smoke_persistent" || result.immediateHasActiveRegistration ||
      result.persistentActiveRevision !== 1 || result.injectedTool?.marker !== "installed" ||
      result.injectedTool?.title !== "userScripts smoke" || result.injectedSourceBound !== true
    ) throw new Error(`packaged runtime result mismatch: ${JSON.stringify(result)}`);
    await waitForValue(page, "document.documentElement.dataset.moaUserScriptsImmediate === 'yes'");
    await page.send("Page.reload");
    await waitForValue(page, "document.readyState === 'complete'");
    await waitForValue(page, "document.documentElement.dataset.moaUserScriptsRegistered === 'yes'");
    const removed = await evaluate(runtimePage, `(async () => {
      const state = globalThis.__moaUserScriptsSmoke;
      const removal = await state.runtime.unregister(state.persistent.artifact_id);
      await state.injectedRuntime.remove(state.installedTool.name);
      const disabled = await state.runtime.setProfileEnabled("reviewed_standalone_v1", false);
      const delegatedDisabled = await state.runtime.setProfileEnabled("delegated_runtime_v1", false);
      return {
        removalOk: removal.ok,
        disabledState: disabled.state,
        delegatedDisabledState: delegatedDisabled.state,
        remaining: (await chrome.userScripts.getScripts({ ids: ["moa_real_smoke_persistent"] })).length,
      };
    })()`);
    if (!removed.removalOk || removed.disabledState !== "disabled" || removed.delegatedDisabledState !== "disabled" || removed.remaining !== 0) throw new Error("runtime removal/disable was not verified");
    const workerMarker = await evaluate(worker, "globalThis.document?.documentElement?.dataset?.moaUserScriptsImmediate || null");
    if (workerMarker != null) throw new Error("generated source appeared in the service worker");
    console.log(`userScripts real Chrome smoke passed through packaged runtime: state=${state.state}, execute/history/read-back/reload/removal/disable and installed tool execution verified, extension=${extensionId}`);
  } finally {
    details?.close();
    runtimePage?.close();
    page?.close();
    worker?.close();
    browser?.close();
    chrome.kill("SIGTERM");
    server.close();
    if (stderr.includes("--load-extension is not allowed")) throw new Error("Chrome for Testing refused the unpacked extension");
  }
}

main().catch((error) => {
  console.error(`userScripts real Chrome smoke BLOCKED: ${error.message}`);
  process.exitCode = 1;
});

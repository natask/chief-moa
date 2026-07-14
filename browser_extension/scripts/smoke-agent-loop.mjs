// Quiet headless smoke for the REAL background agent-loop driver (CONTRACT
// section 1). Mirrors smoke-cdp.mjs: launches Chrome for Testing with
// --headless=new and a throwaway profile under .gstack/background-qa/<run>/,
// loads the unpacked extension/, and drives the extension's autonomous
// agent-loop poll against a LOCAL STUB gateway (a plain node http server).
//
// The stub serves ONE pending agent task pointed at a local fixture page, then
// answers each step by reading the posted observation:
//   step 0 -> click the element whose label matches the fixture button text,
//   step 1 -> type "moa" into the input,
//   step 2 -> finish { status:"done" }.
// It records every observation and the finish receipt.
//
// Asserts the driver contract:
//   (a) the agent-loop tab is created active:false and NEVER becomes active,
//   (b) the fixture DOM shows the click mutation and the typed value in a later
//       observation the stub received,
//   (c) the stub received the finish receipt with status "done".

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `agent-loop-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const TOKEN = "agent-loop-smoke-token";
const FIXTURE_BUTTON_TEXT = "Poke the box";
const CLICK_MARKER = "poked-4271";
const TYPED_VALUE = "moa";
let latestChromeStderr = "";

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// Static file server so the fixture is served over http://localhost, which the
// manifest content_scripts <all_urls> match auto-injects the content script on.
function serveFixtures() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname === "/" ? "/fixtures/agent-loop.html" : url.pathname;
    const file = join(root, path.replace(/^\/+/, ""));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "localhost", () => {
      resolveServer({ server, port: server.address().port });
    });
  });
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        resolveBody({});
      }
    });
  });
}

// Stub gateway. Serves one agent task, plans three steps from the posted
// observations, and records the finish receipt. Every other route the
// extension's pollers/heartbeat may hit answers benignly so nothing errors.
function startStubGateway(fixtureUrl) {
  const state = { claimed: false, observations: [], finish: null, steps: [], heartbeats: [] };

  function findByLabel(elements, text) {
    const wanted = String(text || "").trim().toLowerCase();
    return (elements || []).find((el) => String(el.label || "").trim().toLowerCase() === wanted)
      || (elements || []).find((el) => String(el.label || "").toLowerCase().includes("poke"))
      || null;
  }

  function findInput(elements) {
    return (elements || []).find((el) => String(el.tag || "").toLowerCase() === "input") || null;
  }

  function planAction(observation) {
    const elements = observation?.elements || [];
    const step = Number(observation?.step ?? state.observations.length - 1);
    if (step === 0) {
      const button = findByLabel(elements, FIXTURE_BUTTON_TEXT);
      if (button) return { action: { kind: "click", index: button.i }, step, done: false };
      return { action: { kind: "finish", status: "blocked", summary: "no button found" }, step, done: true };
    }
    if (step === 1) {
      const input = findInput(elements);
      if (input) return { action: { kind: "type", index: input.i, text: TYPED_VALUE }, step, done: false };
      return { action: { kind: "finish", status: "blocked", summary: "no input found" }, step, done: true };
    }
    return { action: { kind: "finish", status: "done", summary: "done" }, step, done: true };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    if (process.env.SMOKE_DEBUG) console.error("[stub]", req.method, path);
    const respond = (obj, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (path === "/v1/browser/agent-tasks/claim") {
      await readBody(req);
      if (state.claimed) return respond({});
      state.claimed = true;
      return respond({
        task: {
          id: "agent-task-smoke-1",
          status: "claimed",
          instruction: "poke the box and type a note",
          url: fixtureUrl,
          max_steps: 8,
          step_count: 0,
          steps: [],
        },
      });
    }

    const stepsMatch = path.match(/^\/v1\/browser\/agent-tasks\/[^/]+\/steps$/);
    if (stepsMatch) {
      const body = await readBody(req);
      const observation = body?.observation || {};
      state.observations.push(observation);
      const planned = planAction(observation);
      state.steps.push(planned);
      return respond(planned);
    }

    const finishMatch = path.match(/^\/v1\/browser\/agent-tasks\/[^/]+\/finish$/);
    if (finishMatch) {
      const body = await readBody(req);
      state.finish = body || {};
      return respond({ task: { id: "agent-task-smoke-1", status: body?.status || "done", summary: body?.summary || "" } });
    }

    // Benign answers for the other pollers/heartbeat so nothing errors loudly.
    if (path === "/v1/sessions/default") {
      await readBody(req);
      return respond({ session_id: "agent-loop-smoke-session" });
    }
    if (path === "/v1/device-clients/heartbeat") {
      state.heartbeats.push(await readBody(req));
      return respond({ ok: true });
    }
    await readBody(req);
    return respond({});
  });

  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      resolveServer({ server, port: server.address().port, state });
    });
  });
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
  throw new Error(`Timed out waiting for Chrome target. Last: ${JSON.stringify(lastTargets.map((t) => ({ type: t.type, url: t.url })), null, 2)}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
}

// The MV3 service worker can be torn down between setup evaluates when Chrome is
// still settling (worst under back-to-back launches). Retry transient failures.
async function evaluateWithRetry(cdp, expression, attempts = 6) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await evaluate(cdp, expression);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const { server: fixtureServer, port: fixturePort } = await serveFixtures();
  const fixtureUrl = `http://localhost:${fixturePort}/fixtures/agent-loop.html`;
  const { server: stubServer, port: stubPort, state: stub } = await startStubGateway(fixtureUrl);
  const stubBase = `http://127.0.0.1:${stubPort}`;
  mkdirSync(profilePath, { recursive: true });

  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  chrome.stderr.on("data", (chunk) => {
    latestChromeStderr += chunk.toString();
    latestChromeStderr = latestChromeStderr.slice(-4000);
  });

  let workerCdp;
  let browserCdp;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const workerTarget = await waitForTarget(
      devToolsPort,
      (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(t.url || ""),
    );

    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error("The resolved Chrome refused --load-extension. Point AGEE_CHROME_PATH at a Chrome for Testing binary.");
    }
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    // Chrome launches with --no-startup-window, so there is no current window
    // for the extension's chrome.tabs.create until we open one. Create a plain
    // foreground tab (before the recorders below, so it is not counted) to give
    // the agent-loop a window to open its background tab in.
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    await browserCdp.send("Target.createTarget", { url: fixtureUrl });

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");

    // An MV3 service worker suspends in the async gaps between polls (which
    // strands the claim fetch before it dispatches) and can even be torn down
    // between our setup evaluates. A tight concurrent ping keeps it awake from
    // here on; once the loop starts its own chrome.tabs/debugger calls keep it
    // alive. Started before setup so those evaluates cannot race a teardown.
    let keepAlive = true;
    const pinger = (async () => {
      while (keepAlive) {
        await evaluate(workerCdp, "1").catch(() => {});
        await delay(100);
      }
    })();

    // Record tab lifecycle so we can prove the agent-loop tab is never active.
    await evaluateWithRetry(workerCdp, `
      (() => {
        globalThis.__smokeTabEvents = { created: [], activatedUrls: [] };
        chrome.tabs.onCreated.addListener((tab) => {
          globalThis.__smokeTabEvents.created.push({ id: tab.id, active: tab.active === true, url: tab.url || tab.pendingUrl || "" });
        });
        chrome.tabs.onActivated.addListener(async ({ tabId }) => {
          try { const t = await chrome.tabs.get(tabId); globalThis.__smokeTabEvents.activatedUrls.push(t.url || ""); } catch {}
        });
        return true;
      })()
    `);

    // Point the extension at the stub gateway and enable background automation.
    await evaluateWithRetry(workerCdp, `chrome.storage.local.set(${JSON.stringify({
      ageeGatewayUrl: stubBase,
      ageeGatewayToken: TOKEN,
      ageeBackgroundAutomationEnabled: true,
      ageeBackgroundAutomationConsentVersion: 1,
    })}).then(() => true)`);

    // The 2s poll claims the task and drives the loop. Wait for the finish POST.
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && (!stub.finish || stub.heartbeats.length < 1)) {
      await delay(150);
    }
    keepAlive = false;
    await pinger.catch(() => {});
    if (!stub.finish) {
      throw new Error(`agent-loop never posted a finish receipt; observations=${stub.observations.length}, steps=${JSON.stringify(stub.steps)}`);
    }

    // Device discovery advertises the existing browser session as an adapter,
    // bound only to the active app origin. Full path/page evidence stays on the
    // explicit evidence route.
    const heartbeat = stub.heartbeats.find((item) => item?.metadata?.context_descriptor?.availability === "available");
    if (!heartbeat) {
      throw new Error(`no available browser context descriptor reached heartbeat: ${JSON.stringify(stub.heartbeats)}`);
    }
    const descriptor = heartbeat.metadata.context_descriptor;
    if (descriptor.application?.id !== "localhost" || descriptor.application?.origin !== `http://localhost:${fixturePort}`) {
      throw new Error(`heartbeat app identity was not origin-bounded: ${JSON.stringify(descriptor)}`);
    }
    const descriptorJson = JSON.stringify(descriptor);
    if (descriptorJson.includes("/fixtures/") || descriptorJson.includes("page_text")) {
      throw new Error(`heartbeat leaked full location or page evidence: ${descriptorJson}`);
    }
    const sessionAdapter = heartbeat.metadata.execution_adapters?.find((item) => item?.adapter === "browser_session");
    if (sessionAdapter?.status !== "available" || sessionAdapter?.authentication_state !== "not_inspected") {
      throw new Error(`heartbeat did not advertise a bounded browser-session adapter: ${JSON.stringify(sessionAdapter)}`);
    }

    // (c) The stub received the finish receipt with status "done".
    if (stub.finish.status !== "done") {
      throw new Error(`finish receipt status was not "done": ${JSON.stringify(stub.finish)}`);
    }

    // (b) The click mutation and typed value appear in a later observation.
    const mutated = stub.observations.some((obs) => String(obs?.page_text || "").includes(CLICK_MARKER));
    if (!mutated) {
      throw new Error(`no observation showed the click DOM mutation "${CLICK_MARKER}"; observations=${JSON.stringify(stub.observations.map((o) => o.page_text))}`);
    }
    const typed = stub.observations.some((obs) =>
      (obs?.elements || []).some((el) => String(el.label || "").toLowerCase().includes(TYPED_VALUE)),
    );
    if (!typed) {
      throw new Error(`no observation showed the typed value "${TYPED_VALUE}" in an element label`);
    }

    // A screenshot rode step 0's observation (base64_jpeg, under the cap).
    const step0Screenshot = stub.observations[0]?.screenshot;
    if (!step0Screenshot || (step0Screenshot.encoding !== "base64_jpeg" && step0Screenshot.encoding !== "omitted")) {
      throw new Error(`step 0 observation did not carry a valid screenshot field: ${JSON.stringify(step0Screenshot)}`);
    }

    // (a) The agent-loop tab was created active:false and never activated.
    const tabEvents = await evaluateWithRetry(workerCdp, `globalThis.__smokeTabEvents || null`);
    if (!tabEvents || !Array.isArray(tabEvents.created) || tabEvents.created.length < 1) {
      throw new Error(`no background tab was created by the agent-loop: ${JSON.stringify(tabEvents)}`);
    }
    const activeCreated = tabEvents.created.filter((t) => t.active === true);
    if (activeCreated.length) {
      throw new Error(`agent-loop created a tab with active:true (focus/ownership violation): ${JSON.stringify(activeCreated)}`);
    }
    const activatedFixture = (tabEvents.activatedUrls || []).filter((u) => String(u).includes("agent-loop.html"));
    if (activatedFixture.length) {
      throw new Error(`agent-loop tab became active (focus/ownership violation): ${JSON.stringify(activatedFixture)}`);
    }

    console.log(
      "Agent-loop smoke passed (REAL extension, headless Chrome for Testing): " +
        `service worker id=${extensionId}; the driver claimed a stub agent task, opened a background tab ` +
        `(created active:false, never activated), captured a step-0 screenshot, executed click + type through the ` +
        `content-script act path, and posted finish status="${stub.finish.status}". ` +
        `Observations proved the click mutation "${CLICK_MARKER}" and the typed value "${TYPED_VALUE}"; ` +
        `${stub.observations.length} observations, ${stub.steps.length} planned actions; heartbeat advertised the ` +
        `origin-bounded browser_session adapter without inspecting auth; no window shown, no focus taken.`,
    );
  } finally {
    workerCdp?.close();
    browserCdp?.close();
    fixtureServer.close();
    stubServer.close();
    chrome.kill("SIGTERM");
    await delay(300);
    rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  if (latestChromeStderr.trim()) {
    console.error("Chrome stderr tail:");
    console.error(latestChromeStderr.trim());
  }
  process.exit(1);
});

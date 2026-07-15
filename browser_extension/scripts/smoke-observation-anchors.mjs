// Deterministic, quiet smoke for browser-local observation anchors on the real
// extension. Uses Chrome for Testing and a throwaway profile only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runDir = join(root, ".gstack", "background-qa", `observation-anchors-${Date.now()}`);
const profilePath = join(runDir, "chrome-profile");
let latestChromeStderr = "";

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const file = join(root, url.pathname.replace(/^\/+/, ""));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer) => server.listen(0, "0.0.0.0", () => resolveServer({ server, port: server.address().port })));
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

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
    return new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolve: resolveCall, reject: rejectCall }));
  }
  close() { this.ws.close(); }
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

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(cdp, expression).catch(() => undefined);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function extensionMessage(worker, urlPattern, message) {
  return evaluate(worker, `
    (async () => {
      const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(urlPattern)} });
      if (!tab) return null;
      try { return await chrome.tabs.sendMessage(tab.id, ${JSON.stringify(message)}); }
      catch { return null; }
    })()
  `);
}

async function waitForMessage(worker, urlPattern, message) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    const result = await extensionMessage(worker, urlPattern, message);
    if (result) return result;
    await delay(120);
  }
  throw new Error(`Timed out sending ${message.cmd}`);
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const { server, port } = await serve();
  mkdirSync(profilePath, { recursive: true });
  const fixtureUrl = `http://localhost:${port}/fixtures/observation-anchors.html`;
  const urlPattern = `http://localhost:${port}/*`;
  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", (chunk) => {
    latestChromeStderr = `${latestChromeStderr}${chunk}`.slice(-4000);
  });
  let browser;
  let worker;
  let page;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const workerTarget = await waitForTarget(devToolsPort, (target) => target.type === "service_worker" && /\/background\.js$/.test(target.url || ""));
    worker = new Cdp(workerTarget.webSocketDebuggerUrl);
    await worker.send("Runtime.enable");
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((response) => response.json());
    browser = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);
    page = new Cdp(pageTarget.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: fixtureUrl });
    await waitForEval(page, `document.readyState === "complete" && !!document.querySelector("#target")`);
    await waitForMessage(worker, urlPattern, { cmd: "ping" });

    const first = await waitForMessage(worker, urlPattern, { cmd: "snapshot" });
    const target = first.elements.find((element) => element.label === "Stable target");
    assert(target?.observation_anchor, "snapshot target must include a complete anchor");
    const anchor = target.observation_anchor;
    assert.equal(anchor.provenance, "dom");
    assert.equal(anchor.snapshot_id, first.snapshotId);
    assert.equal(anchor.document_id, first.observation.document_id);
    assert.equal(anchor.frame_path[0], "top");
    assert.ok(anchor.element_ref.local_id && anchor.element_ref.fingerprint);
    assert.ok(anchor.geometry.document_rect && anchor.geometry.viewport_rect_at_observation);
    assert.ok(anchor.geometry.scroll_at_observation && anchor.geometry.visual_viewport);
    assert.ok(Number.isFinite(anchor.page_epoch) && Number.isFinite(anchor.layout_epoch));
    assert.ok(!Number.isNaN(Date.parse(anchor.captured_at)));

    const second = await waitForMessage(worker, urlPattern, { cmd: "snapshot" });
    const secondTarget = second.elements.find((element) => element.label === "Stable target");
    assert.equal(secondTarget.observation_anchor.element_ref.local_id, anchor.element_ref.local_id, "same live node must retain its stable ref");

    await evaluate(page, `scrollTo(0, 120); true`);
    await delay(120);
    const afterScroll = await waitForMessage(worker, urlPattern, { cmd: "revalidateObservationAnchor", anchor });
    assert.equal(afterScroll.valid, true, "scroll must retain anchor validity");
    assert.equal(afterScroll.current_geometry.document_rect.y, anchor.geometry.document_rect.y, "scroll must preserve document geometry");
    assert.notEqual(afterScroll.current_geometry.viewport_rect_at_observation.y, anchor.geometry.viewport_rect_at_observation.y, "scroll must reproject viewport geometry");

    await page.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 520, deviceScaleFactor: 1, mobile: true, scale: 1 });
    await page.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
    await delay(160);
    const afterViewport = await waitForMessage(worker, urlPattern, { cmd: "revalidateObservationAnchor", anchor });
    assert.equal(afterViewport.valid, true, "resize/zoom must remeasure the same live node");
    assert.equal(afterViewport.status, "remeasured");
    assert.ok(afterViewport.current_geometry.visual_viewport.scale >= 1, "visual viewport state must remain explicit");

    await evaluate(page, `window.fixture.reflow(); true`);
    await delay(160);
    const afterReflow = await waitForMessage(worker, urlPattern, { cmd: "revalidateObservationAnchor", anchor });
    assert.equal(afterReflow.valid, true, "reflow may remeasure the same live node");
    assert.equal(afterReflow.status, "remeasured");
    assert.notEqual(afterReflow.current_geometry.document_rect.y, anchor.geometry.document_rect.y);

    const badFrame = structuredClone(anchor);
    badFrame.frame_path = ["different-frame"];
    const frameChanged = await waitForMessage(worker, urlPattern, { cmd: "revalidateObservationAnchor", anchor: badFrame });
    assert.deepEqual([frameChanged.valid, frameChanged.reason], [false, "frame_changed"]);

    const ambiguous = structuredClone(anchor);
    ambiguous.element_ref.local_id = "el_missing";
    const ambiguousResult = await waitForMessage(worker, urlPattern, { cmd: "revalidateObservationAnchor", anchor: ambiguous });
    assert.deepEqual([ambiguousResult.valid, ambiguousResult.reason], [false, "ambiguous_identity"]);

    await evaluate(page, `window.fixture.replaceLookalike(); true`);
    await delay(160);
    const replaced = await waitForMessage(worker, urlPattern, { cmd: "revalidateObservationAnchor", anchor });
    assert.deepEqual([replaced.valid, replaced.reason], [false, "node_replaced"], "a lookalike replacement must not inherit identity");
    const replacementSnapshot = await waitForMessage(worker, urlPattern, { cmd: "snapshot" });
    const replacement = replacementSnapshot.elements.find((element) => element.label === "Stable target");
    assert.notEqual(replacement.observation_anchor.element_ref.local_id, anchor.element_ref.local_id);
    assert.ok(replacementSnapshot.observationLimitations.some((item) => item.kind === "canvas_region" && !item.element_identity));
    assert.ok(replacementSnapshot.observationLimitations.some((item) => item.kind === "cross_origin_frame" && !item.element_identity));

    await page.send("Page.navigate", { url: `${fixtureUrl}?revision=2` });
    await waitForEval(page, `location.search === "?revision=2" && document.readyState === "complete"`);
    await waitForMessage(worker, urlPattern, { cmd: "ping" });
    const navigated = await waitForMessage(worker, urlPattern, { cmd: "revalidateObservationAnchor", anchor });
    assert.deepEqual([navigated.valid, navigated.reason], [false, "page_changed"], "navigation must fail closed");

    console.log("observation-anchor smoke passed: stable scroll ref; viewport/reflow remeasure; replacement, ambiguity, frame and navigation stale; canvas/cross-origin bounded");
  } finally {
    page?.close();
    worker?.close();
    browser?.close();
    server.close();
    chrome.kill("SIGTERM");
    await delay(250);
    rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  if (latestChromeStderr.trim()) console.error(latestChromeStderr.trim());
  process.exit(1);
});

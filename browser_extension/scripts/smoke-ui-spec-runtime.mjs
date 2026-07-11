import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runDir = join(root, ".gstack", "background-qa", `ui-spec-${Date.now()}`);
const profilePath = join(runDir, "chrome-profile");
const token = "isolated-ui-spec-smoke-token";
let spec = { version: 1, surfaces: [{ id: "main", title: "Before", components: [{ type: "card", id: "status", body: "Initial UI" }], controls: [] }] };
let getCount = 0;

function treeHash(dir) {
  const hash = createHash("sha256");
  function add(path, relative = "") {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), rel = join(relative, name);
      if (statSync(full).isDirectory()) add(full, rel);
      else { hash.update(rel); hash.update(readFileSync(full)); }
    }
  }
  add(dir);
  return hash.digest("hex");
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
async function waitForFile(path, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (existsSync(path)) return readFileSync(path, "utf8"); await delay(100); }
  throw new Error(`timeout waiting for ${path}`);
}
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (!msg.id) return; const pending = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result); };
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolveCall, reject) => this.pending.set(id, { resolve: resolveCall, reject })); }
  close() { this.ws.close(); }
}
async function evalValue(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(port, predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()); const target = list.find(predicate); if (target) return target; await delay(100); }
  throw new Error("target timeout");
}
async function waitEval(cdp, expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await evalValue(cdp, expression).catch(() => null); if (value) return value; await delay(100); }
  throw new Error(`condition timeout: ${expression}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>UI spec runtime</title><main>fixture</main>"); }
  if (url.pathname === "/v1/ui/spec" && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
  if (url.pathname === "/v1/ui/spec" && req.method === "GET") { getCount += 1; res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ spec, is_customized: true })); }
  if (url.pathname === "/v1/ui/spec" && req.method === "PUT") { let body = ""; for await (const chunk of req) body += chunk; spec = JSON.parse(body).spec; res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ spec, is_customized: true })); }
  res.writeHead(404); res.end();
});

await new Promise((ok) => server.listen(0, "localhost", ok));
const gatewayUrl = `http://localhost:${server.address().port}`;
mkdirSync(profilePath, { recursive: true });
const beforeHash = treeHash(extensionPath);
const chrome = spawn(resolveChromeForTesting(), quietChromeArgs({ extensionPath, profilePath }), { stdio: ["ignore", "ignore", "pipe"] });
let worker, page;
try {
  const port = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
  const workerTarget = await waitFor(port, (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(t.url || ""));
  worker = new Cdp(workerTarget.webSocketDebuggerUrl); await worker.send("Runtime.enable");
  await waitEval(worker, `typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? true : null`);
  await evalValue(worker, `(async()=>{await chrome.storage.local.set({ageeGatewayUrl:${JSON.stringify(gatewayUrl)},ageeGatewayToken:${JSON.stringify(token)}});return true})()`);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = new Cdp(version.webSocketDebuggerUrl);
  const created = await browser.send("Target.createTarget", { url: gatewayUrl });
  const pageTarget = await waitFor(port, (t) => t.id === created.targetId);
  page = new Cdp(pageTarget.webSocketDebuggerUrl); await page.send("Runtime.enable");
  await waitEval(page, `document.readyState === "complete" && document.querySelector("#agee-ui-surface") ? true : null`);
  await delay(2100);
  await evalValue(worker, `(async()=>{await AgeeUiSpecRefresh.refresh("runtime_smoke_initial");return true})()`);
  await waitEval(page, `document.querySelector("#agee-ui-surface")?.textContent.includes("Initial UI")`);
  const next = { version: 1, surfaces: [{ id: "main", title: "After", components: [{ type: "card", id: "status", body: "Live updated UI" }], controls: [] }] };
  const put = await fetch(`${gatewayUrl}/v1/ui/spec`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ spec: next }) });
  if (!put.ok) throw new Error(`PUT failed: ${put.status}`);
  await delay(2100);
  const beforeCoalesced = getCount;
  await evalValue(worker, `(async()=>{await Promise.all([AgeeUiSpecRefresh.refresh("runtime_smoke_a"),AgeeUiSpecRefresh.refresh("runtime_smoke_b"),AgeeUiSpecRefresh.refresh("runtime_smoke_c")]);return true})()`);
  if (getCount - beforeCoalesced !== 1) throw new Error(`concurrent refreshes made ${getCount - beforeCoalesced} requests, expected 1`);
  await waitEval(page, `document.querySelector("#agee-ui-surface")?.textContent.includes("Live updated UI")`);
  const afterHash = treeHash(extensionPath);
  if (beforeHash !== afterHash) throw new Error("extension source changed during runtime customization");
  console.log(`ui-spec real runtime smoke passed (source sha256 ${beforeHash})`);
  browser.close();
} finally {
  page?.close(); worker?.close(); chrome.kill("SIGTERM"); server.close(); await delay(200); rmSync(runDir, { recursive: true, force: true });
}

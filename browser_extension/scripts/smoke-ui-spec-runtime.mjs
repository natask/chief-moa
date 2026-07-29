import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runDir = join(root, ".gstack", "background-qa", `ui-spec-${Date.now()}`);
const profilePath = join(runDir, "chrome-profile");
const token = "isolated-ui-spec-smoke-token";
const gatewayDir = resolve(root, "../gateway");

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

const probe = createServer();
await new Promise((ok) => probe.listen(0, "127.0.0.1", ok));
const gatewayPort = probe.address().port;
await new Promise((ok) => probe.close(ok));
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const gateway = spawn(process.execPath, ["server.js"], { cwd: gatewayDir, env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(gatewayPort), DATA_DIR: join(runDir, "gateway-data"), MOA_GATEWAY_TOKEN: token, ALLOW_AGENT_WITHOUT_TOKEN: "0", DATABASE_URL: "" }, stdio: ["ignore", "ignore", "pipe"] });
for (let i = 0; i < 150; i += 1) { if (await fetch(`${gatewayUrl}/health`).then((r) => r.ok).catch(() => false)) break; if (i === 149) throw new Error("actual gateway did not become healthy"); await delay(100); }
const initialPut = await fetch(`${gatewayUrl}/v1/ui/spec`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ spec: { version: 1, surfaces: [{ id: "main", title: "Before", components: [{ type: "card", id: "status", body: "Initial UI" }], controls: [] }] } }) });
if (!initialPut.ok) throw new Error(`actual gateway initial PUT failed: ${initialPut.status}`);
mkdirSync(profilePath, { recursive: true });
const beforeHash = treeHash(extensionPath);
const chrome = spawn(resolveChromeForTesting(), quietChromeArgs({ extensionPath, profilePath }), { stdio: ["ignore", "ignore", "pipe"] });
let worker, page;
try {
  const port = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
  const workerTarget = await waitFor(port, (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(t.url || ""));
  worker = new Cdp(workerTarget.webSocketDebuggerUrl); await worker.send("Runtime.enable");
  await waitEval(worker, `typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? true : null`);
  await waitEval(worker, `(async()=>{const value=await chrome.storage.local.get("ageeGatewayUrl");return typeof value.ageeGatewayUrl==="string"&&value.ageeGatewayUrl.length>0})()`);
  await evalValue(worker, `(async()=>{await chrome.storage.local.set({ageeGatewayUrl:${JSON.stringify(gatewayUrl)},ageeGatewayToken:${JSON.stringify(token)},ageeGatewayUserSet:true});return true})()`);
  // Startup may have refreshed against the default gateway before the test
  // configuration was stored. Cross the refresh gate, fetch explicitly, and
  // prove the initial cache is ready before creating the content-script page.
  const initialReady = await evalValue(worker, `(async()=>{
    for(let attempt=0;attempt<5;attempt+=1){
      if(attempt) await new Promise(resolve=>setTimeout(resolve,2100));
      const payload=await AgeeUiSpecRefresh.refresh("runtime_smoke_initial");
      if(JSON.stringify(payload||{}).includes("Initial UI")) return true;
    }
    return false;
  })()`);
  if (!initialReady) throw new Error("extension never loaded the initial spec from the configured actual gateway");
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = new Cdp(version.webSocketDebuggerUrl);
  const created = await browser.send("Target.createTarget", { url: `${gatewayUrl}/health` });
  const pageTarget = await waitFor(port, (t) => t.id === created.targetId);
  page = new Cdp(pageTarget.webSocketDebuggerUrl); await page.send("Runtime.enable");
  await waitEval(page, `document.readyState === "complete" && document.querySelector("#agee-ui-surface") ? true : null`);
  // The cache barrier above ensures any content-script request can only read
  // from the configured actual gateway. The surface proves the listener and
  // renderer are installed; the required assertion is the subsequent update.
  const next = { version: 1, surfaces: [{ id: "main", title: "After", components: [{ type: "card", id: "status", body: "Live updated UI" }], controls: [{ type: "button", id: "inert", label: "Unknown action", action: "unknown.action" }, { type: "button", id: "open", label: "Open command", action: "command.open", prompt: "safe dispatch" }] }] };
  const put = await fetch(`${gatewayUrl}/v1/ui/spec`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ spec: next }) });
  if (!put.ok) throw new Error(`PUT failed: ${put.status}`);
  await delay(2100);
  await evalValue(worker, `(()=>{const original=globalThis.fetch;globalThis.__uiSpecGets=0;globalThis.fetch=async(...args)=>{if(String(args[0]).includes("/v1/ui/spec"))globalThis.__uiSpecGets++;return original(...args)};return true})()`);
  await evalValue(worker, `(async()=>{await Promise.all([AgeeUiSpecRefresh.refresh("runtime_smoke_a"),AgeeUiSpecRefresh.refresh("runtime_smoke_b"),AgeeUiSpecRefresh.refresh("runtime_smoke_c")]);return true})()`);
  const refreshGets = await evalValue(worker, `globalThis.__uiSpecGets`);
  if (refreshGets !== 1) throw new Error(`concurrent refreshes made ${refreshGets} requests, expected 1`);
  await waitEval(page, `document.querySelector("#agee-ui-surface")?.textContent.includes("Live updated UI")`);
  await evalValue(page, `(()=>{const input=document.querySelector("#agee-ribbon-you .agee-ribbon-text");window.__beforeNoop=input?.textContent||"";[...document.querySelectorAll(".agee-ui-button")].find(b=>b.textContent==="Unknown action").click();return true})()`);
  const noopChanged = await evalValue(page, `document.querySelector("#agee-ribbon-you .agee-ribbon-text")?.textContent !== window.__beforeNoop`);
  if (noopChanged) throw new Error("unknown/noop control produced an observable effect");
  await evalValue(page, `[...document.querySelectorAll(".agee-ui-button")].find(b=>b.textContent==="Open command").click()`);
  await waitEval(page, `document.querySelector("#agee-ribbon-you .agee-ribbon-text")?.textContent === "safe dispatch"`);
  const afterHash = treeHash(extensionPath);
  if (beforeHash !== afterHash) throw new Error("extension source changed during runtime customization");
  console.log(`ui-spec real runtime smoke passed (source sha256 ${beforeHash})`);
  browser.close();
} finally {
  page?.close(); worker?.close(); chrome.kill("SIGTERM"); gateway.kill("SIGTERM"); await delay(200); rmSync(runDir, { recursive: true, force: true });
}

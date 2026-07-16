import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const profileRoot = mkdtempSync(join(tmpdir(), "moa-surface-program-"));
const profile = join(profileRoot, "profile");
const fixture = `<!doctype html><title>Local program fixture</title><button id="continue">Continue</button><input id="note"><output id="status">waiting</output><script>document.querySelector('#continue').onclick=()=>document.querySelector('#status').textContent='clicked';document.querySelector('#note').oninput=()=>{if(document.querySelector('#note').value==='done locally')document.querySelector('#status').textContent='done'}<\/script>`;
const source = `
const [page, tab] = await Promise.all([tools.browser.page.snapshot({}), tools.browser.tab.get({})]);
let choices = await tools.browser.page.queryElements({selector:"#missing"});
let branch = "primary";
if (!choices.length) { branch = "fallback"; choices = await tools.browser.page.queryElements({selector:"#continue"}); }
await tools.browser.page.click({element_id:choices[0].element_id});
const [input] = await tools.browser.page.queryElements({selector:"#note"});
await tools.browser.page.fill({element_id:input.element_id,text:"done locally"});
await tools.browser.page.wait({selector:"#status",text:"done",timeout_ms:1500});
return {branch,title:page.title,tab_id:tab.tab_id};`.trim();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function server() {
  const state = { heartbeat: null, request: null, claimed: false, receipts: [], toolReceipts: [], events: [] };
  const instance = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const send = (value, type = "application/json") => { res.writeHead(200, { "content-type": type }); res.end(type === "application/json" ? JSON.stringify(value) : value); };
    if (req.url === "/fixture") return send(fixture, "text/html");
    if (req.url === "/v1/device-clients/heartbeat") { state.heartbeat = json; return send({ ok: true }); }
    if (req.url === "/v1/tool/requests/claim") {
      state.heartbeat = { ...(state.heartbeat || {}), ...json };
      if (state.request && !state.claimed) { state.claimed = true; return send({ request: state.request }); }
      return send({});
    }
    if (/\/tool-receipts$/.test(req.url || "")) { state.toolReceipts.push(json); return send({ ok: true }); }
    if (/\/events$/.test(req.url || "")) { state.events.push(json); return send({ ok: true }); }
    if (/\/receipts$/.test(req.url || "")) { state.receipts.push(json); return send({ ok: true }); }
    return send({});
  });
  return new Promise((resolveServer) => instance.listen(0, "127.0.0.1", () => resolveServer({ instance, state, port: instance.address().port })));
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 1; this.pending = new Map(); this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }; }
  async send(method, params = {}) { await this.ready; const id = this.id++; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolve: resolveCall, reject: rejectCall })); }
  close() { this.ws.close(); }
}
async function targets(port) { return fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()); }
async function waitFor(fn, timeout = 20000) { const end = Date.now() + timeout; let value; while (Date.now() < end) { value = await fn(); if (value) return value; await delay(100); } throw new Error("isolated smoke timed out"); }
async function evaluate(cdp, expression) { const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }

async function main() {
  const loopback = await server();
  const url = `http://127.0.0.1:${loopback.port}/fixture`;
  const chrome = spawn(resolveChromeForTesting(), quietChromeArgs({ extensionPath: join(root, "extension"), profilePath: profile }), { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = ""; chrome.stderr.on("data", (chunk) => { chromeErrors = (chromeErrors + chunk).slice(-8000); });
  let workerCdp; let pageCdp;
  try {
    const portFile = await waitFor(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8"); } catch { return null; } });
    const port = Number(portFile.split("\n")[0]);
    const worker = await waitFor(async () => {
      for (const target of await targets(port)) {
        if (target.type !== "service_worker" || !target.url.endsWith("/background.js")) continue;
        const candidate = new Cdp(target.webSocketDebuggerUrl);
        try { if (await evaluate(candidate, `chrome.runtime.getManifest().name`) === "A.G.") return target; }
        catch {} finally { candidate.close(); }
      }
      return null;
    });
    const browserInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    const browser = new Cdp(browserInfo.webSocketDebuggerUrl);
    await browser.send("Target.createTarget", { url }); browser.close();
    const page = await waitFor(async () => (await targets(port)).find((t) => t.type === "page" && t.url === url));
    workerCdp = new Cdp(worker.webSocketDebuggerUrl); pageCdp = new Cdp(page.webSocketDebuggerUrl);
    await evaluate(workerCdp, `chrome.storage.local.set(${JSON.stringify({ ageeGatewayUrl: `http://127.0.0.1:${loopback.port}`, ageeGatewayToken: "fixture", ageeBackgroundAutomationEnabled: true, ageeBackgroundAutomationConsentVersion: 1 })}).then(()=>true)`);
    await evaluate(workerCdp, `chrome.tabs.query({url:${JSON.stringify(url)}}).then(([tab])=>chrome.tabs.update(tab.id,{active:true}).then(()=>tab.id))`);
    await waitFor(() => loopback.state.heartbeat?.runtime_advertisements?.[0] && loopback.state.heartbeat?.current_binding?.origin === `http://127.0.0.1:${loopback.port}`, 25000);
    const ad = loopback.state.heartbeat.runtime_advertisements[0];
    const binding = loopback.state.heartbeat.current_binding;
    const makeRequest = (suffix, programSource, wallMs = 5000) => {
      const now = Date.now();
      return { id: `request_${suffix}`, tool: "surface.program.execute", input: {
      version: 1, type: "surface.execution.proposed", execution_id: `exec_${suffix}`, session_id: "session_fixture", turn_id: `turn_${suffix}`,
      target: ad.target, runtime: ad.runtime, program: { source: programSource, sha256: digest(programSource) },
      catalog: { version: ad.catalog.version, sha256: ad.catalog.sha256, allowed_capability_ids: ad.catalog.capability_ids }, bindings: binding,
      limits: { source_bytes: Buffer.byteLength(programSource), wall_ms: wallMs, memory_bytes: null, tool_calls: 20, parallel_calls: 4, result_bytes: 16384, log_bytes: 0 },
      approval_policy: { program: "preauthorized", always_ask: [] }, idempotency_key: `idem_${suffix}`, issued_at: new Date(now).toISOString(), expires_at: new Date(now+30000).toISOString(),
    }};
    };
    loopback.state.request = makeRequest("fixture", source);
    const receipt = await waitFor(() => loopback.state.receipts[0], 30000);
    assert(receipt.status === "completed", JSON.stringify(receipt));
    assert(receipt.tool_attempts?.count >= 7, "expected many local tool calls");
    assert(!("device_id" in receipt) && receipt.claimant?.surface_type === "browser_extension", "terminal receipt was not the closed browser shape");
    assert(receipt.previous_receipt_sha256 === receipt.tool_attempts.last_receipt_sha256, "terminal receipt did not continue the tool chain");
    await waitFor(() => loopback.state.events.at(-1)?.kind === "terminal", 5000);
    const records = await evaluate(workerCdp, `chrome.storage.local.get("ageeSurfaceProgramRecordsV1").then(v=>v.ageeSurfaceProgramRecordsV1)`);
    const localRecord = Object.values(records)[0];
    assert(localRecord.tool_receipts.length === receipt.tool_attempts.count, "tool receipts were not durably recorded before terminal");
    assert(localRecord.tool_receipts.every((item, index, all) => item.previous_receipt_sha256 === (index ? all[index - 1].receipt_sha256 : null)), "tool receipt chain is broken");
    assert(localRecord.events[0].kind === "accepted" && localRecord.events[1].kind === "started" && localRecord.events.at(-1).kind === "terminal", "lifecycle boundaries are incomplete");
    assert(localRecord.events.every((event, index) => event.sequence === index + 1), "lifecycle sequence is not contiguous");
    assert(loopback.state.toolReceipts.length === receipt.tool_attempts.count, "tool receipts were not uploaded individually");
    const uploadedEvents = [...new Map(loopback.state.events.map((event) => [event.event_id, event])).values()].sort((a, b) => a.sequence - b.sequence);
    assert(uploadedEvents.length === localRecord.events.length && uploadedEvents.every((event, index) => event.sequence === index + 1), `lifecycle events were not uploaded idempotently: remote=${uploadedEvents.length} local=${localRecord.events.length}`);
    const state = await evaluate(pageCdp, `({status:document.querySelector('#status').textContent,note:document.querySelector('#note').value})`);
    assert(state.status === "done" && state.note === "done locally", JSON.stringify(state));
    loopback.state.claimed = false;
    const replay = await waitFor(() => loopback.state.receipts[1], 10000);
    assert(replay.receipt_sha256 === receipt.receipt_sha256, "one-shot replay did not return the recorded terminal receipt");
    loopback.state.request = makeRequest("infinite", "while (true) {}", 250);
    loopback.state.claimed = false;
    const timeoutStarted = Date.now();
    const timedOut = await waitFor(() => loopback.state.receipts[2], 5000);
    assert(timedOut.status === "timed_out", JSON.stringify(timedOut));
    assert(Date.now() - timeoutStarted < 5000, "infinite program was not promptly preempted");
    loopback.state.request = makeRequest("recovery", "return await tools.browser.tab.get({});");
    loopback.state.claimed = false;
    const recovered = await waitFor(() => loopback.state.receipts[3], 10000);
    assert(recovered.status === "completed", JSON.stringify(recovered));
    console.log(`surface program smoke passed: isolated Chrome for Testing, localhost fixture/fake gateway, ${receipt.tool_attempts.count} local calls, infinite-loop preemption and recovery, no screenshots or personal profile`);
  } catch (error) { throw new Error(`${error.message}\nChrome stderr:\n${chromeErrors}`); }
  finally { workerCdp?.close(); pageCdp?.close(); loopback.instance.close(); chrome.kill("SIGTERM"); await delay(500); try { rmSync(profileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

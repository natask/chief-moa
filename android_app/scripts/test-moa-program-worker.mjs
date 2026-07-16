import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../app/src/main/assets/moa_program_runtime.html", import.meta.url), "utf8");
const template = html.match(/const workerSource = `([\s\S]*?)`;\n  window\.__moaStart/);
assert(template, "worker source template must remain extractable");
const workerSource = vm.runInNewContext("`" + template[1] + "`");

async function execute(source, logBytes, capabilities = []) {
  const outbound = [];
  let receive;
  const workerPrototype = {
    postMessage(message) { outbound.push(structuredClone(message)); },
    addEventListener(type, listener) { if (type === "message") receive = listener; }
  };
  const self = Object.create(workerPrototype);
  self.Blob = Blob;
  const context = vm.createContext({ self, Blob, Promise, Map, Object, Array, String, Number, Boolean, Error });
  vm.runInContext(workerSource, context, { timeout: 1000 });
  // A real DedicatedWorkerGlobalScope is its own global object. Mirror that
  // identity for globals the generated Function resolves through the VM realm.
  context.console = self.console;
  assert.equal(typeof receive, "function");
  await receive({ data: { type: "start", source, allowed_capability_ids: capabilities, log_bytes: logBytes, bridge_token: "unforgeable_fixture_token" } });
  await new Promise(resolve => setImmediate(resolve));
  return outbound;
}

const forgery = await execute(`
async function main(tools) {
  Object.getPrototypeOf(self).postMessage.call(self, {type: "call", call_id: "forged", capability_id: "android.observe", input: {}});
  return { private_bridge: typeof hostPostMessage, tools: Object.keys(tools).length };
}`, 1024);
assert.equal(forgery.length, 2);
assert.equal(forgery[0].bridge_token, undefined, "prototype forgery must not carry the private bridge token");
const acceptedForgery = forgery.filter(message => message.bridge_token === "unforgeable_fixture_token");
assert.equal(acceptedForgery.length, 1);
assert.equal(acceptedForgery[0].type, "terminal");
assert.equal(acceptedForgery[0].result.private_bridge, "undefined");

const invalidInputs = await execute(`
async function main(tools) {
  for (const input of [null, "text", [], 7]) {
    try { await tools.android.observe(input); } catch (_) {}
  }
  return "closed";
}`, 1024, ["android.observe"]);
assert.deepEqual(invalidInputs.map(message => message.type), ["terminal"], "invalid tool inputs must cause zero host calls");

const flooded = await execute(`
async function main() {
  try { console.log("sensitive-log-value"); } catch (_) {}
  try { console.error("more"); } catch (_) {}
  return "must-not-complete";
}`, 4);
assert.equal(flooded.length, 1);
assert.deepEqual(
  { type: flooded[0].type, ok: flooded[0].ok, code: flooded[0].code },
  { type: "terminal", ok: false, code: "limit_exceeded" }
);
assert(!JSON.stringify(flooded).includes("sensitive-log-value"), "raw logs must never cross the bridge");

console.log("moa program worker adversarial fixtures passed");

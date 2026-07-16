import assert from "node:assert/strict";
import test from "node:test";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadWorker() {
  const messages = [];
  delete globalThis.onmessage;
  globalThis.postMessage = (message) => messages.push(message);
  await import(`../extension/program-sandbox-worker.js?test=${Math.random()}`);
  globalThis.AgeeProgramWorkerRuntime();
  return { messages, deliver: (data) => globalThis.onmessage({ data }) };
}

test("program worker exposes immutable tools and executes parallel branching", async () => {
  const worker = await loadWorker();
  worker.deliver({ type: "wrong" });
  worker.deliver({ type: "program_start", source: `
    const frozen = Object.isFrozen(tools) && Object.isFrozen(tools.browser.page);
    const [page, tab] = await Promise.all([tools.browser.page.snapshot({}), tools.browser.tab.get({})]);
    return {frozen,page,tab};`, result_bytes: 4096, memory_bytes: null, log_bytes: 100 });
  await tick();
  const calls = worker.messages.filter((message) => message.type === "tool_call");
  assert.deepEqual(calls.map((message) => message.capability_id), ["browser.page.snapshot", "browser.tab.get"]);
  worker.deliver({ type: "tool_result", call_id: calls[0].call_id, ok: true, result: "page" });
  worker.deliver({ type: "tool_result", call_id: calls[1].call_id, ok: true, result: "tab" });
  worker.deliver({ type: "tool_result", call_id: 999, ok: true, result: null });
  await tick();
  assert.deepEqual(worker.messages.at(-1), { type: "program_result", ok: true, result: { frozen: true, page: "page", tab: "tab" } });
  worker.deliver({ type: "program_start", source: "return 2", result_bytes: 10, memory_bytes: null, log_bytes: 0 });
});

test("program worker covers every capability and bounds failures", async () => {
  const worker = await loadWorker();
  worker.deliver({ type: "program_start", source: `return Promise.all([
    tools.browser.page.queryElements(), tools.browser.page.getText(), tools.browser.page.wait(),
    tools.browser.page.click(), tools.browser.page.fill(), tools.browser.page.type()
  ]);`, result_bytes: 4096, memory_bytes: null, log_bytes: 100 });
  await tick();
  for (const call of worker.messages.filter((message) => message.type === "tool_call")) {
    worker.deliver({ type: "tool_result", call_id: call.call_id, ok: false, error: "denied" });
  }
  await tick();
  assert.match(worker.messages.at(-1).error, /denied/);

  const invalid = await loadWorker();
  invalid.deliver({ type: "program_start", source: "return 1", result_bytes: 0, memory_bytes: 0, log_bytes: -1 });
  assert.equal(invalid.messages.at(-1).error, "program_resource_limits_invalid");

  const syntax = await loadWorker();
  syntax.deliver({ type: "program_start", source: "return )", result_bytes: 100, memory_bytes: null, log_bytes: 0 });
  assert.equal(syntax.messages.at(-1).ok, false);

  const thrown = await loadWorker();
  thrown.deliver({ type: "program_start", source: "throw new Error('boom')", result_bytes: 100, memory_bytes: null, log_bytes: 0 });
  await tick();
  assert.match(thrown.messages.at(-1).error, /boom/);

  const oversized = await loadWorker();
  oversized.deliver({ type: "program_start", source: "return 'too large'", result_bytes: 2, memory_bytes: null, log_bytes: 0 });
  await tick();
  assert.equal(oversized.messages.at(-1).error, "program_result_too_large");

  const args = await loadWorker();
  args.deliver({ type: "program_start", source: `return tools.browser.tab.get({x:'${"x".repeat(70000)}'})`, result_bytes: 20, memory_bytes: null, log_bytes: 0 });
  await tick();
  assert.equal(args.messages.at(-1).error, "tool_arguments_too_large");

  const circularArgs = await loadWorker();
  circularArgs.deliver({ type: "program_start", source: "const x={};x.x=x;return tools.browser.tab.get(x)", result_bytes: 20, memory_bytes: null, log_bytes: 0 });
  await tick();
  assert.equal(circularArgs.messages.at(-1).error, "tool_arguments_too_large");

  const logs = await loadWorker();
  logs.deliver({ type: "program_start", source: "console.log('a'); console.info('b'); console.warn('c'); console.error('d'); console.debug('e'); return 1", result_bytes: 20, memory_bytes: null, log_bytes: 100 });
  await tick();
  assert.equal(logs.messages.at(-1).result, 1);

  const logLimit = await loadWorker();
  logLimit.deliver({ type: "program_start", source: "const x={};x.x=x;console.log(x);console.log('too much');return 1", result_bytes: 20, memory_bytes: null, log_bytes: 20 });
  await tick();
  assert.equal(logLimit.messages.at(-1).error, "program_log_budget_exceeded");

  const circular = await loadWorker();
  circular.deliver({ type: "program_start", source: "const x={};x.x=x;return x", result_bytes: 100, memory_bytes: null, log_bytes: 0 });
  await tick();
  assert.equal(circular.messages.at(-1).error, "program_result_too_large");

  const undefinedResult = await loadWorker();
  undefinedResult.deliver(null);
  undefinedResult.deliver({ type: "program_start", source: "return undefined", result_bytes: 100, memory_bytes: null, log_bytes: 0 });
  await tick();
  assert.equal(undefinedResult.messages.at(-1).result, null);

  const undefinedError = await loadWorker();
  undefinedError.deliver({ type: "program_start", source: "return Promise.reject()", result_bytes: 100, memory_bytes: null, log_bytes: 0 });
  await tick();
  assert.equal(undefinedError.messages.at(-1).error, "undefined");

  const defaultError = await loadWorker();
  defaultError.deliver({ type: "program_start", source: "return tools.browser.tab.get({})", result_bytes: 100, memory_bytes: null, log_bytes: 0 });
  await tick();
  defaultError.deliver({ type: "tool_result", call_id: 1, ok: false });
  await tick();
  assert.match(defaultError.messages.at(-1).error, /local tool failed/);
});

test("sandbox bootstrap relays one run and terminates its disposable worker", async () => {
  let listener;
  const instances = [];
  class FakeWorker {
    constructor(url) { this.url = url; this.sent = []; this.terminated = false; instances.push(this); }
    postMessage(message) { this.sent.push(message); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  globalThis.URL.createObjectURL = () => "blob:worker";
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.AgeeProgramWorkerRuntime = function fixtureWorker() {};
  globalThis.parent = { parent: true };
  globalThis.addEventListener = (name, value) => { if (name === "message") listener = value; };
  await import(`../extension/program-sandbox-bootstrap.js?test=${Math.random()}`);
  const port = { sent: [], closed: false, postMessage(message) { this.sent.push(message); }, start() {}, close() { this.closed = true; } };
  listener({ source: {}, data: { type: "surface_program_start", source: "return 1" }, ports: [port] });
  listener({ source: parent, data: { type: "wrong", source: "return 1" }, ports: [port] });
  listener({ source: parent, data: { type: "surface_program_start", source: 1 }, ports: [port] });
  listener({ source: parent, data: { type: "surface_program_start", source: "return 1", result_bytes: 10, memory_bytes: 20 }, ports: [port] });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, "blob:worker");
  instances[0].onmessage({ data: { type: "tool_call", call_id: 1 } });
  port.onmessage({ data: { type: "tool_result", call_id: 1, ok: true } });
  assert.equal(instances[0].sent.length, 2);
  instances[0].onmessage({ data: { type: "program_result", ok: true, result: 1 } });
  assert.equal(instances[0].terminated, true);
  assert.equal(port.closed, true);
  assert.equal(port.sent.length, 2);
  instances[0].onmessage({ data: { type: "tool_call" } });
  instances[0].onerror();
  listener({ source: parent, data: { type: "surface_program_start", source: "return 2" }, ports: [port] });

  let secondListener;
  globalThis.parent = { second: true };
  globalThis.addEventListener = (_name, value) => { secondListener = value; };
  await import(`../extension/program-sandbox-bootstrap.js?second=${Math.random()}`);
  const cancelPort = { postMessage() {}, start() {}, close() { this.closed = true; } };
  secondListener({ source: parent, data: { type: "surface_program_start", source: "return 1" }, ports: [cancelPort] });
  cancelPort.onmessage({ data: { type: "program_cancel" } });
  assert.equal(instances.at(-1).terminated, true);

  let thirdListener;
  globalThis.parent = { third: true };
  globalThis.addEventListener = (_name, value) => { thirdListener = value; };
  await import(`../extension/program-sandbox-bootstrap.js?third=${Math.random()}`);
  const errorPort = { sent: [], postMessage(message) { this.sent.push(message); }, start() {}, close() {} };
  thirdListener({ source: parent, data: { type: "surface_program_start", source: "return 1" }, ports: [errorPort] });
  instances.at(-1).onerror();
  assert.equal(errorPort.sent.at(-1).error, "program_worker_failed");

  let cloneListener;
  globalThis.parent = { clone: true };
  globalThis.addEventListener = (_name, value) => { cloneListener = value; };
  await import(`../extension/program-sandbox-bootstrap.js?clone=${Math.random()}`);
  let first = true;
  const clonePort = { sent: [], postMessage(message) { if (first) { first = false; throw new Error("clone"); } this.sent.push(message); }, start() {}, close() {} };
  cloneListener({ source: parent, data: { type: "surface_program_start", source: "return 1" }, ports: [clonePort] });
  instances.at(-1).onmessage({ data: null });
  assert.equal(clonePort.sent.at(-1).error, "program_result_not_cloneable");
});

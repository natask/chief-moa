import assert from "node:assert/strict";
import test from "node:test";

test("sandbox bootstrap exposes only immutable tools and runs branching/parallel code", async () => {
  let messageListener;
  globalThis.parent = { sandboxParent: true };
  globalThis.addEventListener = (name, listener) => { if (name === "message") messageListener = listener; };
  await import(`../extension/program-sandbox-bootstrap.js?test=${Date.now()}`);
  const calls = [];
  const tools = globalThis.AgeeProgramSandboxQa.createToolNamespace(async (capability, args) => { calls.push([capability, args]); return capability; });
  assert.ok(Object.isFrozen(tools) && Object.isFrozen(tools.browser.page));
  await Promise.all([
    tools.browser.page.snapshot(), tools.browser.page.queryElements({ selector: "x" }), tools.browser.page.getText({ selector: "x" }),
    tools.browser.page.wait({ selector: "x" }), tools.browser.page.click({ element_id: "e" }), tools.browser.page.fill({ element_id: "e", text: "x" }),
    tools.browser.page.type({ element_id: "e", text: "x" }), tools.browser.tab.get(),
  ]);
  await Promise.all([tools.browser.page.queryElements(), tools.browser.page.getText(), tools.browser.page.wait(), tools.browser.page.click(), tools.browser.page.fill(), tools.browser.page.type()]);
  assert.equal(calls.length, 14);

  const channel = new MessageChannel();
  const result = new Promise((resolve) => {
    channel.port1.onmessage = (event) => {
      if (event.data.type === "tool_call") channel.port1.postMessage({ type: "tool_result", call_id: event.data.call_id, ok: true, result: event.data.capability_id });
      if (event.data.type === "program_result") resolve(event.data);
    };
  });
  messageListener({ source: {}, data: { type: "surface_program_start", source: "return 0" }, ports: [channel.port2] });
  messageListener({ source: parent, data: { type: "wrong", source: "return 0" }, ports: [channel.port2] });
  messageListener({ source: parent, data: { type: "surface_program_start", source: 1 }, ports: [channel.port2] });
  messageListener({ source: parent, data: { type: "surface_program_start", source: "const [a,b]=await Promise.all([tools.browser.page.snapshot({}),tools.browser.tab.get({})]); return {a,b};" }, ports: [channel.port2] });
  assert.deepEqual(await result, { type: "program_result", ok: true, result: { a: "browser.page.snapshot", b: "browser.tab.get" } });
  channel.port1.close();

  const run = async (source, toolResponse = null) => {
    const failureChannel = new MessageChannel();
    return new Promise((resolve) => {
      failureChannel.port1.onmessage = (event) => {
        if (event.data.type === "tool_call") failureChannel.port1.postMessage({ type: "tool_result", call_id: event.data.call_id, ...(toolResponse || { ok: false, error: "denied" }) });
        if (event.data.type === "program_result") { failureChannel.port1.close(); resolve(event.data); }
      };
      globalThis.AgeeProgramSandboxQa.runProgram(failureChannel.port2, source);
    });
  };
  assert.match((await run("throw new Error('boom')")).error, /boom/);
  assert.match((await run("return await tools.browser.page.snapshot({})")).error, /denied/);

  const synthetic = { messages: [], postMessage(message) { this.messages.push(message); }, start() {}, close() {} };
  globalThis.AgeeProgramSandboxQa.runProgram(synthetic, "return await tools.browser.tab.get({})");
  synthetic.onmessage({ data: null });
  synthetic.onmessage({ data: { type: "other" } });
  synthetic.onmessage({ data: { type: "tool_result", call_id: 999, ok: true } });
  synthetic.onmessage({ data: { type: "tool_result", call_id: 1, ok: false } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(synthetic.messages.at(-1).error, /local tool failed/);

  let secondListener;
  globalThis.parent = { freshParent: true };
  globalThis.addEventListener = (_name, value) => { secondListener = value; };
  await import(`../extension/program-sandbox-bootstrap.js?fresh=${Date.now()}`);
  secondListener({ source: parent, data: { type: "surface_program_start", source: "return 1" }, ports: [] });
  secondListener({ source: parent, data: { type: "surface_program_start", source: "return 1" }, ports: [{ postMessage() {}, start() {}, close() {} }] });
  secondListener({ source: parent, data: { type: "surface_program_start", source: "return 2" }, ports: [{ postMessage() {}, start() {}, close() {} }] });
});

import assert from "node:assert/strict";
import test from "node:test";

function installBridgeEnvironment(mode = "result") {
  let runtimeListener;
  const sent = [];
  globalThis.chrome = {
    runtime: {
      id: "extension_fixture",
      getURL: (path) => `chrome-extension://extension_fixture/${path}`,
      onMessage: { addListener: (listener) => { runtimeListener = listener; } },
      sendMessage: async (message) => { sent.push(message); if (mode === "reject") throw new Error("bridge rejected"); if (mode === "reject-string") throw "bridge rejected string"; if (mode === "clone") return { ok: true, result: () => {} }; return { ok: true, result: "tool-ok" }; },
    },
  };
  globalThis.document = {
    body: { append(iframe) { queueMicrotask(() => iframe.load?.()); } },
    createElement() {
      return {
        hidden: false, src: "", removed: false,
        setAttribute() {}, remove() { this.removed = true; },
        addEventListener(_name, listener) { this.load = listener; },
        contentWindow: { postMessage(message, _origin, ports) {
          const [port] = ports;
          if (mode === "timeout") return;
          if (["tool", "reject", "reject-string", "clone", "closing"].includes(mode)) {
            port.onmessage = (event) => {
              if (event.data.type === "tool_result") port.postMessage({ type: "program_result", ok: event.data.ok, result: event.data.result, error: event.data.error });
            };
            port.start();
            port.postMessage({ type: "tool_call", call_id: 1, capability_id: "browser.tab.get", args: {} });
            if (mode === "closing") {
              port.postMessage({ type: "program_result", ok: true, result: "early" });
              port.postMessage({ type: "tool_call", call_id: 2, capability_id: "browser.tab.get", args: {} });
            }
            return;
          }
          port.postMessage(null);
          port.postMessage({ type: "program_result", ok: true, result: { done: true, source: message.source } });
        } },
      };
    },
  };
  return { listener: () => runtimeListener, sent };
}

test("offscreen bridge validates bounds and completes sandbox results", async () => {
  const env = installBridgeEnvironment();
  const { executeInProgramSandbox } = await import(`../extension/surface-program-offscreen-bridge.js?happy=${Date.now()}`);
  assert.deepEqual(await executeInProgramSandbox({ execution_id: "e", run_token: "t", source: "return 1", wall_ms: 100 }), { ok: true, result: { done: true, source: "return 1" }, error: "" });
  assert.match((await executeInProgramSandbox({ source: "", wall_ms: 100 })).error, /source/);
  assert.match((await executeInProgramSandbox({ source: null, wall_ms: 100 })).error, /source/);
  assert.match((await executeInProgramSandbox({ source: "x".repeat(70_000), wall_ms: 100 })).error, /source/);
  assert.match((await executeInProgramSandbox({ source: "return 1", wall_ms: 1 })).error, /wall/);
  assert.match((await executeInProgramSandbox({ source: "return 1", wall_ms: 40_000 })).error, /wall/);
  assert.match((await executeInProgramSandbox({ source: "return 1", wall_ms: 100.5 })).error, /wall/);
  const invalidSender = await new Promise((resolve) => env.listener()({ cmd: "surfaceProgramRun", source: "return 1", wall_ms: 100 }, { id: "other" }, resolve));
  assert.match(invalidSender.error, /sender/);
  assert.equal(env.listener()({ cmd: "other" }, {}, () => {}), false);
  const tabSender = await new Promise((resolve) => env.listener()({ cmd: "surfaceProgramRun", source: "return 1", wall_ms: 100 }, { id: "extension_fixture", tab: {} }, resolve));
  assert.match(tabSender.error, /sender/);
  const valid = await new Promise((resolve) => env.listener()({ cmd: "surfaceProgramRun", execution_id: "e2", run_token: "t2", source: "return 1", wall_ms: 100 }, { id: "extension_fixture" }, resolve));
  assert.equal(valid.ok, true);
});

test("offscreen bridge forwards local calls and drains before terminal", async () => {
  const env = installBridgeEnvironment("tool");
  const { executeInProgramSandbox } = await import(`../extension/surface-program-offscreen-bridge.js?tool=${Date.now()}`);
  const result = await executeInProgramSandbox({ execution_id: "exec", run_token: "token", source: "return 1", wall_ms: 200 });
  assert.deepEqual(result, { ok: true, result: "tool-ok", error: "" });
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].capability_id, "browser.tab.get");
});

test("offscreen bridge enforces wall time", async () => {
  installBridgeEnvironment("timeout");
  const { executeInProgramSandbox } = await import(`../extension/surface-program-offscreen-bridge.js?timeout=${Date.now()}`);
  assert.deepEqual(await executeInProgramSandbox({ execution_id: "e", run_token: "t", source: "return 1", wall_ms: 100 }), { ok: false, error: "program_wall_time_exceeded" });
});

test("offscreen bridge reports host rejection, clone failures, and closing calls", async () => {
  installBridgeEnvironment("reject");
  let module = await import(`../extension/surface-program-offscreen-bridge.js?reject=${Date.now()}`);
  assert.match((await module.executeInProgramSandbox({ execution_id: "e", run_token: "t", source: "return 1", wall_ms: 200 })).error, /bridge rejected/);
  installBridgeEnvironment("reject-string");
  module = await import(`../extension/surface-program-offscreen-bridge.js?rejectString=${Date.now()}`);
  assert.match((await module.executeInProgramSandbox({ execution_id: "e", run_token: "t", source: "return 1", wall_ms: 200 })).error, /rejected string/);
  installBridgeEnvironment("clone");
  module = await import(`../extension/surface-program-offscreen-bridge.js?clone=${Date.now()}`);
  assert.match((await module.executeInProgramSandbox({ execution_id: "e", run_token: "t", source: "return 1", wall_ms: 200 })).error, /cloneable/);
  installBridgeEnvironment("closing");
  module = await import(`../extension/surface-program-offscreen-bridge.js?closing=${Date.now()}`);
  assert.deepEqual(await module.executeInProgramSandbox({ execution_id: "e", run_token: "t", source: "return 1", wall_ms: 200 }), { ok: true, result: "early", error: "" });
});

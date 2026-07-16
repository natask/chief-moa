(() => {
  "use strict";

  function createToolNamespace(call) {
    return Object.freeze({
      browser: Object.freeze({
        page: Object.freeze({
          snapshot: (args = {}) => call("browser.page.snapshot", args),
          queryElements: (args = {}) => call("browser.page.query_elements", args),
          getText: (args = {}) => call("browser.page.get_text", args),
          wait: (args = {}) => call("browser.page.wait", args),
          click: (args = {}) => call("browser.page.click", args),
          fill: (args = {}) => call("browser.page.fill", args),
          type: (args = {}) => call("browser.page.type", args),
        }),
        tab: Object.freeze({ get: (args = {}) => call("browser.tab.get", args) }),
      }),
    });
  }

  function runProgram(port, source) {
    const pending = new Map();
    let nextCall = 1;
    const call = (capabilityId, args) => new Promise((resolve, reject) => {
      const callId = nextCall++;
      pending.set(callId, { resolve, reject });
      port.postMessage({ type: "tool_call", call_id: callId, capability_id: capabilityId, args });
    });
    port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type !== "tool_result") return;
      const waiting = pending.get(message.call_id);
      if (!waiting) return;
      pending.delete(message.call_id);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(String(message.error || "local tool failed")));
    };
    port.start();
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction("tools", `"use strict";\n${source}\n//# sourceURL=aggie-surface-program.js`);
    Promise.resolve(execute(createToolNamespace(call))).then(
      (result) => {
        try { port.postMessage({ type: "program_result", ok: true, result }); }
        catch { port.postMessage({ type: "program_result", ok: false, error: "program_result_not_cloneable" }); }
      },
      (error) => port.postMessage({ type: "program_result", ok: false, error: String(error?.message || error).slice(0, 2000) }),
    ).finally(() => port.close());
  }

  let started = false;
  addEventListener("message", (event) => {
    if (started) return;
    if (event.source !== parent || event.data?.type !== "surface_program_start" || typeof event.data?.source !== "string") return;
    const [port] = event.ports || [];
    if (!port) return;
    started = true;
    runProgram(port, event.data.source);
  });

  globalThis.AgeeProgramSandboxQa = Object.freeze({ createToolNamespace, runProgram });
})();

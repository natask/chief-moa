globalThis.AgeeProgramWorkerRuntime = function AgeeProgramWorkerRuntime() {
  "use strict";

  let started = false;
  let nextCall = 1;
  let resultBytes = 0;
  let logBytes = 0;
  let loggedBytes = 0;
  let inFlightBytes = 0;
  const pending = new Map();
  const encoder = new TextEncoder();
  const emit = globalThis.postMessage.bind(globalThis);

  function boundedJson(value, limit, errorCode) {
    let json;
    try { json = JSON.stringify(value ?? null); } catch { throw new Error(errorCode); }
    if (encoder.encode(json).byteLength > limit) throw new Error(errorCode);
    return { json, value: JSON.parse(json) };
  }

  function call(capabilityId, args = {}) {
    return new Promise((resolve, reject) => {
      let encoded;
      try { encoded = boundedJson(args, 64 * 1024, "tool_arguments_too_large"); }
      catch (error) { reject(error); return; }
      const bytes = encoder.encode(encoded.json).byteLength;
      if (inFlightBytes + bytes > 1024 * 1024) { reject(new Error("program_bridge_budget_exceeded")); return; }
      inFlightBytes += bytes;
      const callId = nextCall++;
      pending.set(callId, { resolve, reject, bytes });
      emit({ type: "tool_call", call_id: callId, capability_id: capabilityId, args: encoded.value });
    });
  }

  function toolsNamespace() {
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

  function recordLog(args) {
    let json;
    try { json = JSON.stringify(args); } catch { json = "[unserializable]"; }
    loggedBytes += encoder.encode(json).byteLength;
    if (loggedBytes > logBytes) throw new Error("program_log_budget_exceeded");
  }

  const boundedConsole = Object.freeze({
    log: (...args) => recordLog(args), info: (...args) => recordLog(args),
    warn: (...args) => recordLog(args), error: (...args) => recordLog(args),
    debug: (...args) => recordLog(args),
  });
  Object.defineProperty(globalThis, "console", { value: boundedConsole, writable: false, configurable: false });
  Object.defineProperty(globalThis, "postMessage", { value: undefined, writable: false, configurable: false });

  globalThis.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "tool_result") {
      const waiting = pending.get(message.call_id);
      if (!waiting) return;
      pending.delete(message.call_id);
      inFlightBytes -= waiting.bytes;
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(String(message.error || "local tool failed")));
      return;
    }
    if (started || message.type !== "program_start" || typeof message.source !== "string") return;
    started = true;
    resultBytes = Number(message.result_bytes);
    logBytes = Number(message.log_bytes);
    if (!Number.isSafeInteger(resultBytes) || resultBytes < 1 || message.memory_bytes !== null || !Number.isSafeInteger(logBytes) || logBytes < 0) {
      emit({ type: "program_result", ok: false, error: "program_resource_limits_invalid" });
      return;
    }
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const execute = new AsyncFunction("tools", "console", `"use strict";\n${message.source}\n//# sourceURL=aggie-surface-program.js`);
      Promise.resolve(execute(toolsNamespace(), boundedConsole)).then(
        (result) => {
          try { emit({ type: "program_result", ok: true, result: boundedJson(result, resultBytes, "program_result_too_large").value }); }
          catch (error) { emit({ type: "program_result", ok: false, error: String(error?.message || error) }); }
        },
        (error) => emit({ type: "program_result", ok: false, error: String(error?.message || error).slice(0, 2000) }),
      );
    } catch (error) {
      emit({ type: "program_result", ok: false, error: String(error?.message || error).slice(0, 2000) });
    }
  };
};

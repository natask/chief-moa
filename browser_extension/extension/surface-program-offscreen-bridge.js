const PROGRAM_SANDBOX_URL = chrome.runtime.getURL("program-sandbox.html");

function executeInProgramSandbox({ execution_id, run_token, source, wall_ms, result_bytes, memory_bytes, log_bytes }) {
  return new Promise((resolve) => {
    if (typeof source !== "string" || !source.trim() || new TextEncoder().encode(source).byteLength > 64 * 1024) return resolve({ ok: false, error: "program_source_invalid" });
    if (!Number.isInteger(wall_ms) || wall_ms < 100 || wall_ms > 30_000) return resolve({ ok: false, error: "program_wall_limit_invalid" });
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src = PROGRAM_SANDBOX_URL;
    iframe.setAttribute("sandbox", "allow-scripts");
    const channel = new MessageChannel();
    let settled = false;
    let closing = false;
    let pendingToolCalls = 0;
    let programResult = null;
    const finish = (result) => {
      /* c8 ignore next -- defensive idempotency guard for racing host callbacks */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { channel.port1.postMessage({ type: "program_cancel" }); } catch {}
      channel.port1.close();
      iframe.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "program_wall_time_exceeded" }), wall_ms);
    channel.port1.onmessage = async (event) => {
      const message = event.data || {};
      if (message.type === "tool_call") {
        if (closing) {
          channel.port1.postMessage({ type: "tool_result", call_id: message.call_id, ok: false, error: "surface_program_closing" });
          return;
        }
        pendingToolCalls += 1;
        try {
          const response = await chrome.runtime.sendMessage({
            cmd: "surfaceProgramToolCall",
            execution_id,
            run_token,
            call_id: message.call_id,
            capability_id: message.capability_id,
            args: message.args,
          });
          try { channel.port1.postMessage({ type: "tool_result", call_id: message.call_id, ...response }); }
          catch { channel.port1.postMessage({ type: "tool_result", call_id: message.call_id, ok: false, error: "tool_result_not_cloneable" }); }
        } catch (error) {
          channel.port1.postMessage({ type: "tool_result", call_id: message.call_id, ok: false, error: String(error?.message || error) });
        } finally {
          pendingToolCalls -= 1;
          if (programResult && pendingToolCalls === 0) finish(programResult);
        }
        return;
      }
      if (message.type === "program_result") {
        closing = true;
        programResult = { ok: message.ok === true, result: message.result, error: message.error || "" };
        if (pendingToolCalls === 0) finish(programResult);
      }
    };
    channel.port1.start();
    iframe.addEventListener("load", () => {
      iframe.contentWindow.postMessage({ type: "surface_program_start", source, result_bytes, memory_bytes, log_bytes }, "*", [channel.port2]);
    }, { once: true });
    document.body.append(iframe);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.cmd !== "surfaceProgramRun") return false;
  if (sender.id !== chrome.runtime.id || sender.tab) {
    sendResponse({ ok: false, error: "surface_program_sender_not_authorized" });
    return true;
  }
  executeInProgramSandbox(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

export { executeInProgramSandbox };

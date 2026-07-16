(() => {
  "use strict";

  let started = false;
  addEventListener("message", (event) => {
    if (started) return;
    if (event.source !== parent || event.data?.type !== "surface_program_start") return;
    const [port] = event.ports || [];
    if (!port || typeof event.data?.source !== "string") return;
    started = true;
    const workerUrl = URL.createObjectURL(new Blob([`(${globalThis.AgeeProgramWorkerRuntime.toString()})()`], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);
    let terminal = false;
    const close = () => {
      if (terminal) return;
      terminal = true;
      worker.terminate();
      port.close();
    };
    worker.onmessage = (workerEvent) => {
      if (terminal) return;
      const message = workerEvent.data || {};
      try { port.postMessage(message); }
      catch { port.postMessage({ type: "program_result", ok: false, error: "program_result_not_cloneable" }); }
      if (message.type === "program_result") close();
    };
    worker.onerror = () => {
      if (!terminal) port.postMessage({ type: "program_result", ok: false, error: "program_worker_failed" });
      close();
    };
    port.onmessage = (portEvent) => {
      if (portEvent.data?.type === "program_cancel") { close(); return; }
      if (!terminal && portEvent.data?.type === "tool_result") worker.postMessage(portEvent.data);
    };
    port.start();
    worker.postMessage({
      type: "program_start",
      source: event.data.source,
      result_bytes: event.data.result_bytes,
      memory_bytes: event.data.memory_bytes,
      log_bytes: event.data.log_bytes,
    });
  });
})();

import { parseBrowserSearchIntent, parseOpenTabIntent } from "./browser-task-intent.js";

function createBrowserCommandRuntime({ automation, send, saveTaskState, throwIfAborted } = {}) {
  async function execute(tabId, instruction, signal, cueId) {
    const search = parseBrowserSearchIntent(instruction);
    const open = search ? null : parseOpenTabIntent(instruction);
    if (!search && !open) return false;
    throwIfAborted(signal);
    const request = search
      ? { tool: "browser.search.open", input: search }
      : { tool: "browser.navigate", input: { url: open.url, new_tab: true, active: true } };
    const receipt = await automation.execute(request);
    const summary = receipt?.summary || receipt?.error || "Browser command failed.";
    send(tabId, { cmd: receipt?.ok ? "done" : "error", cueId, summary, text: summary, local_receipt: receipt?.local_receipt || null });
    await saveTaskState(cueId, {
      status: receipt?.ok ? "done" : "error",
      instruction,
      step: 1,
      tabId,
      lastResult: summary,
      openedTabId: receipt?.result?.tab_id || null,
      localReceipt: receipt?.local_receipt || null,
    });
    return true;
  }

  return Object.freeze({ execute });
}

export { createBrowserCommandRuntime };

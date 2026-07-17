"use strict";

// Chief MOA-owned page capability. Dependencies are injected by the service
// worker so this module cannot manufacture browser authority or approval.
export async function executeBrowserPageAutomation(input, deps) {
  const operation = String(input.operation || "").trim();
  const tabId = Number(input.target_tab_id ?? input.tab_id);
  if (!Number.isFinite(tabId)) return { ok: false, error: "browser.page_automation requires target_tab_id", summary: "Browser page operation was missing a target tab." };
  if (operation === "inspect_page") {
    await deps.ensureContent(tabId);
    const snap = await deps.ask(tabId, { cmd: "snapshot" });
    return {
      ok: true,
      summary: `Inspected page ${snap?.title || "target tab"}.`,
      result: { url: snap?.url || "", title: snap?.title || "", page_text: snap?.page_text || "", screen: deps.snapToScreen(snap) },
      local_receipt: { tool: "browser.page_automation", operation, permission: "read_only", tab_id: tabId, success: true },
    };
  }
  if (operation === "apply_page_tweak") {
    if (input.permission !== "full_control" || !(await deps.isBackgroundAutomationEnabled())) {
      return { ok: false, error: "full-control browser operation requires explicit local extension consent", summary: "Page tweak was held because local extension consent is absent." };
    }
    const record = input.tweak && typeof input.tweak === "object" ? input.tweak : null;
    if (!record || !record.kind) return { ok: false, error: "apply_page_tweak requires a validated tweak record", summary: "Page tweak was rejected because its record was missing." };
    await deps.ensureContent(tabId);
    const result = await deps.sendMessage(tabId, { cmd: "tweak:applyRecord", record });
    return {
      ok: result?.ok === true,
      summary: result?.ok ? "Applied Chief MOA page tweak locally." : String(result?.error || "Page tweak was rejected."),
      result: result?.tweak || null,
      local_receipt: { tool: "browser.page_automation", operation, permission: "full_control", tab_id: tabId, success: result?.ok === true },
    };
  }
  return { ok: false, error: "unsupported browser.page_automation operation", summary: "Browser page operation was rejected." };
}

export function browserPageAutomationToolManifest() {
  return { tool: "browser.page_automation", risk: "read_only_or_full_control", approval: "local_explicit_for_write", capability: "chief-moa.browser-automation.v1" };
}

export function browserLocalToolManifest() {
  return [
    { tool: "browser.tab.list", risk: "read_only", approval: "none" },
    { tool: "browser.tab.open", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.activate", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.close", risk: "destructive_browser_local", approval: "implicit_user_command" },
    { tool: "browser.tab.reload", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.cdp.execute", risk: "browser_local_debugger", approval: "implicit_user_command" },
    { tool: "browser.task.claim", risk: "browser_local", approval: "none" },
    { tool: "page.snapshot", risk: "read_only", approval: "none" },
    browserPageAutomationToolManifest(),
  ];
}

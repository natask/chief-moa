"use strict";

// Chief MOA-owned browser capability contract. Tweeks is prior art only: this
// module contains no external package or transport dependency. The gateway
// validates and queues these records; a browser extension/local adapter owns
// page inspection, execution, and local receipts.
const crypto = require("node:crypto");
const { validatePageTweak } = require("./page-tweaks");

const BROWSER_AUTOMATION_TOOL = "browser.page_automation";
const BROWSER_AUTOMATION_CAPABILITY = "chief-moa.browser-automation.v1";
const OPERATIONS = Object.freeze(["inspect_page", "apply_page_tweak"]);
const text = (value, max) => String(value == null ? "" : value).trim().slice(0, max);

function validateBrowserAutomationRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "browser automation request is required" };
  const operation = text(input.operation || input.action, 60).toLowerCase();
  if (!OPERATIONS.includes(operation)) return { ok: false, error: `unsupported browser automation operation: ${operation || "(none)"}`, supported_operations: OPERATIONS.slice() };
  const expectedPermission = operation === "inspect_page" ? "read_only" : "full_control";
  const permission = text(input.permission || expectedPermission, 40).toLowerCase();
  if (permission !== expectedPermission) return { ok: false, error: `${operation} requires ${expectedPermission} permission` };
  const targetTabId = text(input.target_tab_id || input.tab_id, 120);
  if (!targetTabId) return { ok: false, error: "target_tab_id is required" };
  const request = { operation, permission, target_tab_id: targetTabId };
  if (input.origin) request.origin = text(input.origin, 500);
  if (operation === "inspect_page") {
    request.include = Array.isArray(input.include) ? input.include.map((item) => text(item, 40)).filter(Boolean).slice(0, 12) : ["url", "title", "page_text"];
  } else {
    const tweak = validatePageTweak(input.tweak || input.record);
    if (!tweak.ok) return { ok: false, error: tweak.error };
    request.tweak = tweak.record;
    request.approval_required = true;
  }
  return { ok: true, request };
}

function browserAutomationCapabilityDescriptor() {
  return {
    capability: BROWSER_AUTOMATION_CAPABILITY,
    tool: BROWSER_AUTOMATION_TOOL,
    owner: "browser_extension_local",
    execution: "local_only",
    permissions: { read_only: ["inspect_page"], full_control: ["apply_page_tweak"] },
    description: "Inspect the current page or apply a validated page tweak through the Chief MOA browser extension. The gateway queues; the local extension executes and receipts.",
  };
}

function createBrowserAutomationReceipt(request, result, now = () => new Date().toISOString()) {
  return {
    id: `local_receipt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    capability: BROWSER_AUTOMATION_CAPABILITY,
    operation: request.operation,
    permission: request.permission,
    target_tab_id: request.target_tab_id,
    ok: result?.ok === true,
    summary: text(result?.summary || (result?.ok ? "browser operation completed" : "browser operation failed"), 500),
    result: result?.data ?? null,
    created_at: now(),
  };
}

// Contract/fake adapter for deterministic smoke evidence. The real extension
// adapter will use the same request and receipt shapes but remains local.
function createFakeBrowserAutomationAdapter(options = {}) {
  const available = options.available !== false;
  const localApproval = typeof options.localApproval === "function" ? options.localApproval : () => false;
  const inspect = options.inspect || (() => ({ url: "https://fixture.invalid", title: "Fixture", page_text: "fixture page" }));
  const apply = options.apply || ((request) => ({ tweak: request.tweak }));
  return {
    discover: browserAutomationCapabilityDescriptor,
    async execute(input) {
      const checked = validateBrowserAutomationRequest(input);
      if (!checked.ok) return { ok: false, error: checked.error };
      const request = checked.request;
      if (!available) return { ok: false, error: "Chief MOA browser extension bridge is unavailable" };
      if (request.permission === "full_control" && (await localApproval(request)) !== true) return { ok: false, error: "full-control browser operation requires explicit local approval" };
      const data = request.operation === "inspect_page" ? await inspect(request) : await apply(request);
      return { ok: true, data, receipt: createBrowserAutomationReceipt(request, { ok: true, data }) };
    },
  };
}

module.exports = { BROWSER_AUTOMATION_TOOL, BROWSER_AUTOMATION_CAPABILITY, OPERATIONS, browserAutomationCapabilityDescriptor, validateBrowserAutomationRequest, createBrowserAutomationReceipt, createFakeBrowserAutomationAdapter };

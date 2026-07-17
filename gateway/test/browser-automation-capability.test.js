"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BROWSER_AUTOMATION_CAPABILITY,
  BROWSER_AUTOMATION_TOOL,
  browserAutomationCapabilityDescriptor,
  createFakeBrowserAutomationAdapter,
  validateBrowserAutomationRequest,
} = require("../lib/browser-automation-capability");
const { browserPageAutomation } = require("../lib/surface-skills");

test("Chief MOA advertises a local browser capability with distinct permissions", () => {
  const descriptor = browserAutomationCapabilityDescriptor();
  assert.equal(descriptor.capability, BROWSER_AUTOMATION_CAPABILITY);
  assert.equal(descriptor.tool, BROWSER_AUTOMATION_TOOL);
  assert.deepEqual(descriptor.permissions, { read_only: ["inspect_page"], full_control: ["apply_page_tweak"] });
  assert.equal(descriptor.execution, "local_only");
});

test("fake local adapter inspects, gates writes, receipts, and reports bridge outage", async () => {
  const inspectRequest = validateBrowserAutomationRequest({ operation: "inspect_page", target_tab_id: "tab-1" });
  assert.equal(inspectRequest.ok, true);
  const adapter = createFakeBrowserAutomationAdapter({ inspect: () => ({ title: "Inbox" }) });
  const inspected = await adapter.execute(inspectRequest.request);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.data.title, "Inbox");
  assert.equal(inspected.receipt.permission, "read_only");
  assert.match(inspected.receipt.id, /^local_receipt_/);

  const write = { operation: "apply_page_tweak", target_tab_id: "tab-1", tweak: { kind: "dark" } };
  const denied = await adapter.execute(write);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /explicit local approval/);
  const applied = await adapter.execute({ ...write, approval_granted: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.receipt.permission, "full_control");

  const unavailable = await createFakeBrowserAutomationAdapter({ available: false }).execute(inspectRequest.request);
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error, /bridge is unavailable/);
});

test("surface assistant path queues validated requests and never executes them", async () => {
  const calls = [];
  const result = await browserPageAutomation(
    { source: "browser", conversation_id: "session-1" },
    {
      createToolRequest: async (request) => { calls.push(request); return { id: "req-1" }; },
      readToolRequest: async () => ({ status: "pending", receipts: [] }),
      delay: async () => {},
      browserToolReceiptTimeoutMs: 1,
      browserToolReceiptPollMs: 1,
    },
    { operation: "inspect_page", target_tab_id: "tab-1" },
  );
  assert.equal(result.queued, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, BROWSER_AUTOMATION_TOOL);
  assert.equal(calls[0].target_surface_type, "browser_extension");
  assert.equal(calls[0].input.permission, "read_only");
  assert.equal(calls[0].input.operation, "inspect_page");
});

test("permission mismatches and malformed tweaks fail closed", () => {
  assert.equal(validateBrowserAutomationRequest({ operation: "inspect_page", permission: "full_control", target_tab_id: "tab" }).ok, false);
  assert.equal(validateBrowserAutomationRequest({ operation: "apply_page_tweak", target_tab_id: "tab", tweak: { kind: "execute_js" } }).ok, false);
});

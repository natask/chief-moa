"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_ARGS,
  createTweeksMcpClient,
  loadTweeksMcpConfig,
  validateTweeksToolRequest,
} = require("../lib/tweeks-mcp");
const { tweeksMcpTool } = require("../lib/surface-skills");

function fixtureTransport() {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "initialize") return { protocolVersion: "2024-11-05" };
      if (method === "tools/list") return { tools: [{ name: "tweeks.get_system_info", description: "fixture metadata" }] };
      if (method === "tools/call") return { content: [{ type: "text", text: "fixture" }], structuredContent: { extension_version: "fixture" } };
      return {};
    },
    async notify(method) { calls.push({ method }); },
    close() {},
  };
}

test("Tweeks config defaults to the official command and metadata-only allowlist", () => {
  const config = loadTweeksMcpConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.command, "npx");
  assert.deepEqual(config.args, DEFAULT_ARGS);
  assert.deepEqual(config.allowed_tools, ["tweeks.get_system_info"]);
  assert.equal(config.allow_browser_tools, false);
});

test("Tweeks MCP discovers and dispatches through the assistant wrapper", async () => {
  const transport = fixtureTransport();
  const client = createTweeksMcpClient({ config: { enabled: true, allowed_tools: ["tweeks.get_system_info"], allow_browser_tools: false, allow_browser_actions: false, timeout_ms: 1000 }, transportFactory: async () => transport });
  const discovered = await tweeksMcpTool({}, { tweeksMcp: client }, { operation: "discover" });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.tools[0].name, "tweeks.get_system_info");
  const result = await tweeksMcpTool({}, { tweeksMcp: client }, { operation: "call", tool_name: "tweeks.get_system_info", arguments: {} });
  assert.equal(result.ok, true);
  assert.equal(result.permission, "metadata_only");
  assert.equal(transport.calls.filter((call) => call.method === "tools/call").length, 1);
  client.close();
});

test("Tweeks MCP fails closed when unavailable or browser access is not configured", async () => {
  const unavailable = createTweeksMcpClient({ config: { enabled: false, allowed_tools: ["tweeks.get_system_info"] } });
  const result = await tweeksMcpTool({}, { tweeksMcp: unavailable }, { operation: "call", tool_name: "tweeks.get_system_info", arguments: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /disabled/);
  assert.equal(validateTweeksToolRequest({ tool_name: "tweeks.click", arguments: {} }, { allowed_tools: ["tweeks.click"], allow_browser_tools: false, allow_browser_actions: false }).ok, false);
  assert.equal(validateTweeksToolRequest({ tool_name: "tweeks.get_system_info", arguments: { cookies: "no" } }, { allowed_tools: ["tweeks.get_system_info"], allow_browser_tools: false, allow_browser_actions: false }).ok, false);
});

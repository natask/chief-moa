"use strict";

const { spawn } = require("node:child_process");

const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = Object.freeze(["-y", "@tweeks/mcp", "serve"]);
const DEFAULT_ALLOWED_TOOLS = Object.freeze(["tweeks.get_system_info"]);
const SENSITIVE_KEY = /(?:cookie|password|secret|token|authorization|credential|storage|session)/i;
const BROWSER_ACTION = /(?:click|fill|type|press|navigate|open|close|select|upload|download|submit|execute|evaluate|script|write|delete)/i;

function loadTweeksMcpConfig(env = process.env) {
  const split = (value) => String(value || "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  const allowed = split(env.MOA_TWEEKS_MCP_ALLOWED_TOOLS);
  return {
    enabled: String(env.MOA_TWEEKS_MCP_ENABLED || "0") === "1",
    command: String(env.MOA_TWEEKS_MCP_COMMAND || DEFAULT_COMMAND).trim() || DEFAULT_COMMAND,
    args: split(env.MOA_TWEEKS_MCP_ARGS).length ? split(env.MOA_TWEEKS_MCP_ARGS) : [...DEFAULT_ARGS],
    cwd: String(env.MOA_TWEEKS_MCP_CWD || "").trim(),
    allowed_tools: allowed.length ? allowed : [...DEFAULT_ALLOWED_TOOLS],
    allow_browser_tools: String(env.MOA_TWEEKS_MCP_ALLOW_BROWSER || "0") === "1",
    allow_browser_actions: String(env.MOA_TWEEKS_MCP_ALLOW_BROWSER_ACTIONS || "0") === "1",
    timeout_ms: boundedInteger(env.MOA_TWEEKS_MCP_TIMEOUT_MS, 1500, 120000, 15000),
  };
}

function validateTweeksToolRequest(input, config) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Tweeks MCP request is required" };
  const toolName = String(input.tool_name || input.tool || "").trim();
  if (!toolName) return { ok: false, error: "tool_name is required" };
  if (!config.allowed_tools.includes(toolName)) return { ok: false, error: `Tweeks MCP tool is not allowlisted: ${toolName}` };
  const args = input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments) ? input.arguments : {};
  if (containsSensitiveKey(args)) return { ok: false, error: "Tweeks MCP arguments may not contain credentials, cookies, tokens, or browser storage" };
  const systemInfo = toolName === "tweeks.get_system_info";
  if (!systemInfo && !config.allow_browser_tools) return { ok: false, error: "browser-affecting Tweeks MCP tools require MOA_TWEEKS_MCP_ALLOW_BROWSER=1" };
  const action = !systemInfo && BROWSER_ACTION.test(toolName);
  if (action && (!config.allow_browser_actions || input.approval_granted !== true)) {
    return { ok: false, error: "browser-affecting Tweeks MCP tools require explicit approval and MOA_TWEEKS_MCP_ALLOW_BROWSER_ACTIONS=1" };
  }
  return { ok: true, request: { tool_name: toolName, arguments: args, permission: systemInfo ? "metadata_only" : (action ? "full_control" : "read_only") } };
}

function createTweeksMcpClient(options = {}) {
  const config = options.config || loadTweeksMcpConfig(options.env || process.env);
  const transportFactory = options.transportFactory || (() => createStdioTransport(config, options.spawn || spawn));
  let transport = null;
  let initialized = false;
  let initialization = null;
  let tools = null;

  async function initialize() {
    if (!config.enabled) throw unavailable("Tweeks MCP is disabled; set MOA_TWEEKS_MCP_ENABLED=1");
    if (initialized) return;
    if (!initialization) {
      initialization = (async () => {
        transport = await transportFactory();
        await transport.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chief-moa", version: "1.0" },
        });
        await transport.notify("notifications/initialized", {});
        initialized = true;
      })().catch((error) => {
        initialization = null;
        transport?.close?.();
        transport = null;
        throw unavailable(cleanError(error));
      });
    }
    return initialization;
  }

  return Object.freeze({
    config,
    async listTools() {
      await initialize();
      const result = await transport.request("tools/list", {});
      tools = Array.isArray(result?.tools) ? result.tools : [];
      return tools.filter((tool) => config.allowed_tools.includes(String(tool?.name || ""))).map(publicTool);
    },
    async callTool(input) {
      const checked = validateTweeksToolRequest(input, config);
      if (!checked.ok) return checked;
      await initialize();
      if (!tools) await this.listTools();
      if (!tools.some((tool) => tool?.name === checked.request.tool_name)) return { ok: false, error: `Tweeks MCP tool was not discovered: ${checked.request.tool_name}` };
      const result = await transport.request("tools/call", { name: checked.request.tool_name, arguments: checked.request.arguments });
      return { ok: true, tool_name: checked.request.tool_name, permission: checked.request.permission, result: redact(result) };
    },
    close() {
      transport?.close?.();
      transport = null;
      initialized = false;
      initialization = null;
      tools = null;
    },
  });
}

function createStdioTransport(config, spawnImpl) {
  const child = spawnImpl(config.command, config.args, { cwd: config.cwd || undefined, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  const timeout = (id) => setTimeout(() => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    waiter.reject(unavailable("Tweeks MCP request timed out"));
  }, config.timeout_ms);
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || "Tweeks MCP error"));
      else waiter.resolve(message.result || {});
    }
  });
  const fail = () => { for (const waiter of pending.values()) waiter.reject(unavailable("Tweeks MCP process exited")); pending.clear(); };
  child.on("error", fail);
  child.on("exit", fail);
  return {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = timeout(id);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); return Promise.resolve(); },
    close() { child.kill(); fail(); },
  };
}

function publicTool(tool) {
  return { name: String(tool?.name || ""), description: String(tool?.description || "").slice(0, 500), inputSchema: tool?.inputSchema || undefined };
}

function containsSensitiveKey(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(child));
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redact(child)]));
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function unavailable(message) { const error = new Error(message); error.code = "TWEEKS_MCP_UNAVAILABLE"; return error; }
function cleanError(error) { return String(error?.message || error || "Tweeks MCP unavailable").replace(/[\r\n]+/g, " ").slice(0, 500); }

module.exports = { DEFAULT_ARGS, DEFAULT_ALLOWED_TOOLS, loadTweeksMcpConfig, validateTweeksToolRequest, createTweeksMcpClient, createStdioTransport };

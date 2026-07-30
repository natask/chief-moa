import { CAPABILITY_STATES, DELEGATED_PROFILE, createUserScriptsRuntime, sourceDigest } from "./user-scripts-runtime.js";

const TOOL_SCHEMA = "moa.browser-injected-tool.v1";
const TOOL_PREFIX = "browser.injected.";
const STORE_KEY = "ageeBrowserInjectedTools";
const RECEIPT_KEY = "ageeBrowserInjectedToolReceipts";
const MAX_TOOLS = 32;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;
const MAX_RECEIPTS = 100;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function byteCount(value) {
  return new TextEncoder().encode(value).byteLength;
}

function exactToolName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) throw new Error("tool_name_invalid");
  return name;
}

function exactMatchPattern(value) {
  if (typeof value !== "string" || value.length > 512 || !/^https?:\/\//.test(value)) throw new Error("match_invalid");
  const slash = value.indexOf("/", value.indexOf("//") + 2);
  if (slash < 0 || value.slice(0, slash).includes("*")) throw new Error("match_host_must_be_exact");
  new URL(value.replace(/\*+$/, ""));
  return value;
}

function normalizedInputSchema(value) {
  const schema = value == null ? { type: "object", properties: {}, additionalProperties: false } : structuredClone(value);
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") throw new Error("input_schema_invalid");
  if (schema.additionalProperties !== false) throw new Error("input_schema_must_be_closed");
  const properties = schema.properties || {};
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length > 32) throw new Error("input_schema_invalid");
  const normalized = {};
  for (const [key, property] of Object.entries(properties)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !property || typeof property !== "object" || Array.isArray(property)) throw new Error("input_schema_invalid");
    if (!["string", "number", "integer", "boolean"].includes(property.type)) throw new Error("input_schema_type_unsupported");
    normalized[key] = {
      type: property.type,
      ...(typeof property.description === "string" ? { description: property.description.slice(0, 240) } : {}),
      ...(Number.isFinite(property.maxLength) && property.type === "string" ? { maxLength: Math.min(Math.max(1, Math.floor(property.maxLength)), 4000) } : {}),
    };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((key) => !Object.hasOwn(normalized, key)) || new Set(required).size !== required.length) throw new Error("input_schema_invalid");
  return { type: "object", properties: normalized, required: [...required].sort(), additionalProperties: false };
}

async function normalizedTool(value, subtle) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== TOOL_SCHEMA) throw new Error("tool_schema_invalid");
  const name = exactToolName(value.name);
  const description = String(value.description || "").trim();
  if (!description || description.length > 500) throw new Error("tool_description_invalid");
  const source = String(value.source || "");
  if (!source || byteCount(source) > MAX_SOURCE_BYTES || !/^\s*(?:async\s*)?\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>/.test(source)) throw new Error("tool_source_must_be_arrow_function");
  const matches = Array.isArray(value.matches) ? [...new Set(value.matches.map(exactMatchPattern))].sort() : [];
  if (!matches.length || matches.length > 16) throw new Error("tool_matches_invalid");
  const effect = value.effect === "read" ? "read" : "";
  if (!effect) throw new Error(value.effect === "page_change" ? "tool_effect_requires_checkpoint_runtime" : "tool_effect_invalid");
  return {
    schema: TOOL_SCHEMA,
    name,
    tool: `${TOOL_PREFIX}${name}`,
    description,
    effect,
    matches,
    input_schema: normalizedInputSchema(value.input_schema),
    source,
    source_sha256: await sourceDigest(source, subtle),
    enabled: value.enabled !== false,
  };
}

function urlMatches(urlText, patterns) {
  let url;
  try { url = new URL(urlText); } catch { return false; }
  return patterns.some((pattern) => {
    const slash = pattern.indexOf("/", pattern.indexOf("//") + 2);
    if (url.origin !== pattern.slice(0, slash)) return false;
    const pathPattern = pattern.slice(slash).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${pathPattern}$`).test(`${url.pathname}${url.search}${url.hash}`);
  });
}

function validateArguments(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool_arguments_invalid");
  const keys = Object.keys(value);
  if (keys.some((key) => !Object.hasOwn(schema.properties, key)) || schema.required.some((key) => !Object.hasOwn(value, key))) throw new Error("tool_arguments_invalid");
  const output = {};
  for (const key of keys) {
    const rule = schema.properties[key], candidate = value[key];
    const valid = rule.type === "integer" ? Number.isInteger(candidate)
      : rule.type === "number" ? typeof candidate === "number" && Number.isFinite(candidate)
        : typeof candidate === rule.type;
    if (!valid || (rule.type === "string" && candidate.length > (rule.maxLength || 4000))) throw new Error("tool_arguments_invalid");
    output[key] = candidate;
  }
  return output;
}

function boundedResult(value) {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return byteCount(json) <= MAX_RESULT_BYTES ? JSON.parse(json) : { truncated: true, byte_count: byteCount(json) };
  } catch {
    return { truncated: true, unserializable: true };
  }
}

function createBrowserInjectedToolRuntime({ chromeApi = globalThis.chrome, subtle = globalThis.crypto?.subtle, now = () => new Date() } = {}) {
  const storage = chromeApi.storage.local;
  const userScripts = createUserScriptsRuntime({ chromeApi, subtle });

  async function storedTools() {
    const stored = await storage.get({ [STORE_KEY]: {} });
    return stored[STORE_KEY] && typeof stored[STORE_KEY] === "object" ? stored[STORE_KEY] : {};
  }

  async function list() {
    return Object.values(await storedTools()).sort((left, right) => left.name.localeCompare(right.name));
  }

  async function save(value) {
    const tool = await normalizedTool(value, subtle);
    const tools = await storedTools();
    if (!Object.hasOwn(tools, tool.name) && Object.keys(tools).length >= MAX_TOOLS) throw new Error("tool_limit_reached");
    tools[tool.name] = tool;
    await storage.set({ [STORE_KEY]: tools });
    return tool;
  }

  async function remove(name) {
    const tools = await storedTools();
    delete tools[exactToolName(name)];
    await storage.set({ [STORE_KEY]: tools });
    return { ok: true };
  }

  async function capability() {
    return userScripts.capability(DELEGATED_PROFILE);
  }

  async function manifest() {
    const state = await capability();
    if (state.state !== CAPABILITY_STATES.AVAILABLE) return [];
    return (await list()).filter((tool) => tool.enabled).map((tool) => ({
      tool: tool.tool,
      risk: "reviewed_page_code_read",
      approval: "installed_source_and_scope",
      description: tool.description,
    }));
  }

  async function appendReceipt(record) {
    const stored = await storage.get({ [RECEIPT_KEY]: [] });
    const receipts = Array.isArray(stored[RECEIPT_KEY]) ? stored[RECEIPT_KEY] : [];
    await storage.set({ [RECEIPT_KEY]: [...receipts, record].slice(-MAX_RECEIPTS) });
  }

  async function execute(toolName, requestInput = {}) {
    const state = await capability();
    if (state.state !== CAPABILITY_STATES.AVAILABLE) throw new Error(`injected_tool_runtime_${state.state}`);
    const localName = String(toolName || "").startsWith(TOOL_PREFIX) ? String(toolName).slice(TOOL_PREFIX.length) : toolName;
    const tool = (await storedTools())[exactToolName(localName)];
    if (!tool?.enabled) throw new Error("injected_tool_unavailable");
    const tabId = Number(requestInput.tab_id ?? requestInput.tabId);
    const tab = Number.isInteger(tabId) ? await chromeApi.tabs.get(tabId) : (await chromeApi.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab?.id || !urlMatches(tab.url, tool.matches)) throw new Error("injected_tool_scope_mismatch");
    const origin = new URL(tab.url).origin;
    if (!(await chromeApi.permissions.contains({ origins: [`${origin}/*`] }))) throw new Error("injected_tool_host_permission_revoked");
    const args = validateArguments(requestInput.arguments || requestInput.input || {}, tool.input_schema);
    const probe = await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: () => null });
    const documentId = probe[0]?.documentId;
    if (!documentId) throw new Error("injected_tool_document_unavailable");
    const inputJson = stableJson(args);
    const inputSha256 = await sourceDigest(inputJson, subtle);
    const code = `(${tool.source})(${inputJson})`;
    const execution = await chromeApi.userScripts.execute({
      target: { tabId: tab.id, documentIds: [documentId] },
      js: [{ code }],
      world: "USER_SCRIPT",
      injectImmediately: false,
    });
    const result = boundedResult(execution?.[0]?.result);
    const receipt = {
      schema: "moa.browser-injected-tool-receipt.v1",
      tool: tool.tool,
      source_sha256: tool.source_sha256,
      input_sha256: inputSha256,
      tab_id: tab.id,
      document_id: documentId,
      page_origin: origin,
      page_url_sha256: await sourceDigest(tab.url, subtle),
      effect: tool.effect,
      world: "USER_SCRIPT",
      result_present: execution?.[0]?.result !== undefined,
      executed_at: now().toISOString(),
    };
    await appendReceipt(receipt);
    return { ok: true, summary: `Ran installed browser tool ${tool.tool}.`, result, local_receipt: receipt };
  }

  return Object.freeze({ capability, execute, list, manifest, remove, save });
}

export { STORE_KEY, TOOL_PREFIX, TOOL_SCHEMA, createBrowserInjectedToolRuntime };

import { createHash } from "node:crypto";
import { assertSchema, schemas } from "./schemas.js";

const PRODUCT_PREFIX = "product:v1:";

export class IntentLauncherError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "IntentLauncherError";
    this.code = options.code || "INTENT_LAUNCHER_ERROR";
    this.status = options.status;
    this.details = options.details;
    this.requestId = options.requestId;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.status ? { status: this.status } : {}),
        ...(this.requestId ? { request_id: this.requestId } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableIdempotencyKey(operation, input) {
  const prefix = requiredText(operation, "operation").replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 80);
  const digest = createHash("sha256").update(stable(input)).digest("hex").slice(0, 32);
  return `${prefix}:${digest}`;
}

function encodedProduct(product) {
  assertSchema("product", product);
  const provenance = Buffer.from(stable(product.provenance), "utf8").toString("base64url");
  const fields = [
    encodeURIComponent(product.product_id),
    encodeURIComponent(product.revision),
    encodeURIComponent(product.digest.toLowerCase()),
    encodeURIComponent(product.media_type || "application/octet-stream"),
    encodeURIComponent(product.locator),
    provenance,
  ];
  const ref = `${PRODUCT_PREFIX}${fields.join(":")}`;
  if (ref.length > 400) throw new TypeError("encoded Product reference exceeds PR63's 400-character artifact reference limit");
  return ref;
}

export function decodeProductRef(ref) {
  if (!String(ref).startsWith(PRODUCT_PREFIX)) return null;
  const fields = String(ref).slice(PRODUCT_PREFIX.length).split(":");
  if (fields.length !== 6) return null;
  try {
    return {
      product_id: decodeURIComponent(fields[0]),
      revision: decodeURIComponent(fields[1]),
      digest: decodeURIComponent(fields[2]),
      media_type: decodeURIComponent(fields[3]),
      locator: decodeURIComponent(fields[4]),
      provenance: JSON.parse(Buffer.from(fields[5], "base64url").toString("utf8")),
      artifact_ref: ref,
    };
  } catch {
    return null;
  }
}

function queryString(filters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export class IntentLauncherClient {
  constructor(options = {}) {
    this.baseUrl = new URL(options.baseUrl || "https://api.agee.app");
    if (this.baseUrl.protocol !== "https:" && this.baseUrl.hostname !== "127.0.0.1" && this.baseUrl.hostname !== "localhost") {
      throw new TypeError("baseUrl must use HTTPS except for localhost");
    }
    this.token = requiredText(options.token, "token");
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== "function") throw new TypeError("fetch implementation is required");
    this.timeoutMs = Number(options.timeoutMs) || 30_000;
  }

  async request(method, pathname, body) {
    const url = new URL(pathname, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new IntentLauncherError(
        cause?.name === "AbortError" ? `request timed out after ${this.timeoutMs}ms` : `request failed: ${cause?.message || cause}`,
        { code: cause?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", cause },
      );
    } finally {
      clearTimeout(timer);
    }
    const requestId = response.headers?.get?.("x-request-id") || undefined;
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new IntentLauncherError(`server returned non-JSON response (${response.status})`, {
        code: "INVALID_RESPONSE", status: response.status, requestId,
      });
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || `HTTP ${response.status}`;
      const conflict = response.status === 409 || /version conflict/i.test(String(message));
      throw new IntentLauncherError(
        conflict ? `${message}; read the intent again and retry with its current version` : String(message),
        {
          code: conflict ? "VERSION_CONFLICT" : response.status === 401 ? "UNAUTHORIZED" : "API_ERROR",
          status: response.status,
          requestId,
          details: data,
        },
      );
    }
    return data;
  }

  createMessage(input) {
    assertSchema("messageCreate", input);
    return this.request("POST", "/v1/intent-runtime/messages", input);
  }

  createIntent(input) {
    assertSchema("intentCreate", input);
    return this.request("POST", "/v1/intent-runtime/intents", input);
  }

  searchIntents(filters = {}) {
    return this.request("GET", `/v1/intent-runtime/intents${queryString(filters)}`);
  }

  getIntent(intentId) {
    return this.request("GET", `/v1/intent-runtime/intents/${encodeURIComponent(requiredText(intentId, "intent_id"))}`);
  }

  async updateIntent(intentId, input) {
    assertSchema("mutation", input);
    const type = requiredText(input.type || "intent.enriched", "type");
    return this.request("POST", `/v1/intent-runtime/intents/${encodeURIComponent(intentId)}/transition`, { ...input, type });
  }

  forkIntent(parentIntentId, input) {
    assertSchema("messageCreate", input);
    return this.createMessage({
      ...input,
      routing: { ...(input.routing || {}), action: "fork_intent", parent_intent_id: parentIntentId },
    });
  }

  relateIntents(sourceIntentId, input) {
    assertSchema("mutation", input);
    requiredText(input.target_intent_id, "target_intent_id");
    requiredText(input.relation_type, "relation_type");
    return this.request("POST", `/v1/intent-runtime/intents/${encodeURIComponent(sourceIntentId)}/connect`, input);
  }

  async searchAgents(filters = {}) {
    const data = await this.readStatus(filters);
    return { items: data.agents || [], schema: data.schema };
  }

  async getAgent(agentId, filters = {}) {
    const found = (await this.searchAgents(filters)).items.find((item) => item.agent_id === agentId);
    if (!found) throw new IntentLauncherError("agent not found", { code: "NOT_FOUND", status: 404 });
    return { agent: found };
  }

  async searchRuns(filters = {}) {
    const agents = (await this.searchAgents(filters)).items;
    return {
      items: agents.filter((agent) => agent.current_run_id).map((agent) => ({
        run_id: agent.current_run_id,
        agent_id: agent.agent_id,
        intent_id: agent.intent_id,
        status: agent.status,
        recovery_state: agent.recovery_state,
        lease_expires_at: agent.lease_expires_at,
      })),
    };
  }

  async getRun(runId, filters = {}) {
    const found = (await this.searchRuns(filters)).items.find((item) => item.run_id === runId);
    if (!found) throw new IntentLauncherError("run not found in the bounded status projection", { code: "NOT_FOUND", status: 404 });
    return { run: found };
  }

  claimWork(intentId, input) {
    assertSchema("claim", input);
    return this.request("POST", `/v1/intent-runtime/intents/${encodeURIComponent(intentId)}/claim`, input);
  }

  releaseWork(intentId, input) {
    assertSchema("mutation", input);
    return this.request("POST", `/v1/intent-runtime/intents/${encodeURIComponent(intentId)}/transition`, {
      ...input,
      type: "intent.waiting",
      next_step: input.next_step || "Unclaimed work is available for reassignment.",
    });
  }

  reportProgress(intentId, input) {
    assertSchema("progress", input);
    return this.request("POST", `/v1/intent-runtime/intents/${encodeURIComponent(intentId)}/progress`, input);
  }

  proposeCompletion(intentId, input) {
    assertSchema("progress", input);
    if (!Array.isArray(input.evidence_refs) || input.evidence_refs.length === 0) {
      throw new TypeError("candidate completion requires at least one evidence_ref");
    }
    return this.reportProgress(intentId, {
      ...input,
      progress: input.progress || "Candidate completion proposed.",
      next_step: input.next_step || "Independent verifier must assess the attached evidence.",
    });
  }

  attachProduct(intentId, input) {
    assertSchema("progress", input);
    const ref = encodedProduct(input.product);
    return this.reportProgress(intentId, {
      ...input,
      artifact_refs: [...new Set([...(input.artifact_refs || []), ref])],
    });
  }

  async searchProducts(filters = {}) {
    const listed = await this.searchIntents(filters);
    const products = [];
    for (const intent of listed.items || []) {
      for (const ref of intent.artifact_refs || []) {
        const product = decodeProductRef(ref);
        if (product) products.push({ ...product, intent_id: intent.intent_id });
      }
    }
    return { items: products };
  }

  async getProduct(productId, revision, filters = {}) {
    const found = (await this.searchProducts(filters)).items.find(
      (item) => item.product_id === productId && item.revision === revision,
    );
    if (!found) throw new IntentLauncherError("Product revision not found in the bounded intent projection", { code: "NOT_FOUND", status: 404 });
    return { product: found };
  }

  async createAttentionItem(intentId, input) {
    assertSchema("attention", input);
    return this.request("PATCH", `/v1/intent-plane/intents/${encodeURIComponent(intentId)}`, {
      status: "needs_user",
      next_action: input.message,
      current_run_id: input.run_id || input.current_run_id,
      idempotency_key: input.idempotency_key,
    });
  }

  async searchAttentionItems(filters = {}) {
    const data = await this.readStatus(filters);
    return {
      items: (data.notifications || []).filter((item) => item.kind === "needs_user"),
      schema: data.schema,
    };
  }

  async getAttentionItem(notificationId, filters = {}) {
    const found = (await this.searchAttentionItems(filters)).items.find((item) => item.notification_id === notificationId);
    if (!found) throw new IntentLauncherError("attention item not found in the bounded status projection", { code: "NOT_FOUND", status: 404 });
    return { attention_item: found };
  }

  readStatus(filters = {}) {
    return this.request("GET", `/v1/intent-plane${queryString(filters)}`);
  }
}

export { schemas };

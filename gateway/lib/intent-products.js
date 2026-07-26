"use strict";

const crypto = require("node:crypto");

const PRODUCT_TYPES = new Set(["text_document", "git_repository"]);

function clean(value, max = 400) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > max) throw new Error(`value exceeds max length ${max}`);
  return text;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function requestFingerprint(payload) {
  const canonical = { ...payload };
  delete canonical.created_at;
  return hash(stable(canonical));
}

function createIntentProductAuthority({ events, ownerId, now } = {}) {
  if (!events?.appendEvent || !events?.listEvents) throw new Error("product authority requires event substrate");
  const owner = clean(ownerId, 160);
  if (!owner) throw new Error("product authority requires server-derived owner");
  const clock = () => {
    const value = typeof now === "function" ? now() : new Date().toISOString();
    return new Date(value).toISOString();
  };

  async function stream(productId) {
    const rows = await events.listEvents({ stream_id: `product:${productId}`, order: "asc", offset: 0, limit: 500 });
    rows.sort((a, b) => Number(a.stream_version || 0) - Number(b.stream_version || 0));
    return rows;
  }

  function project(rows) {
    if (!rows.length) return null;
    const created = rows[0].payload;
    const revisions = rows.filter((event) => event.event_type === "product.revision_created")
      .map((event) => ({ ...event.payload, event_id: event.event_id, version: event.stream_version }));
    const headEvent = [...rows].reverse().find((event) => event.event_type === "product.head_updated");
    return {
      product_id: created.product_id,
      owner_id: created.owner_id,
      product_type: created.product_type,
      title: created.title,
      format: created.format,
      schema: created.schema,
      storage_policy: created.storage_policy,
      head_revision_id: headEvent?.payload?.revision_id || "",
      head_version: headEvent?.stream_version || 0,
      revisions,
      version: rows.at(-1).stream_version,
    };
  }

  async function existingKey(key) {
    const rows = await events.listEvents({ idempotency_key: key, order: "asc", limit: 2 });
    if (rows.length > 1) throw new Error("duplicate product idempotency key");
    return rows[0] || null;
  }

  async function append(productId, eventType, rawKey, payload, expectedVersion) {
    const key = `product:${productId}:${rawKey}`;
    const fingerprint = requestFingerprint(payload);
    const prior = await existingKey(key);
    if (prior) {
      if (prior.payload?.request_fingerprint !== fingerprint) throw new Error("product idempotency collision");
      return prior;
    }
    return events.appendEvent({
      stream_id: `product:${productId}`,
      event_type: eventType,
      occurred_at: clock(),
      actor: { kind: "user", id: owner },
      authority: { boundary: "single_owner_intent_authority", owner_id: owner },
      correlation_id: productId,
      idempotency_key: key,
      expected_stream_version: expectedVersion,
      payload: { ...payload, request_fingerprint: fingerprint },
    });
  }

  async function createProduct(input = {}) {
    if (input.owner_id && input.owner_id !== owner) throw new Error("caller-selected owner is forbidden");
    const productId = clean(input.product_id, 160) || `product_${crypto.randomUUID()}`;
    const productType = clean(input.product_type, 80);
    if (!PRODUCT_TYPES.has(productType)) throw new Error("unsupported product_type");
    const payload = {
      product_id: productId,
      owner_id: owner,
      product_type: productType,
      title: clean(input.title, 240),
      format: clean(input.format || (productType === "git_repository" ? "application/vnd.git" : "text/markdown"), 120),
      schema: clean(input.schema, 160),
      storage_policy: clean(input.storage_policy || "reference", 80),
      created_at: clock(),
    };
    await append(productId, "product.created", input.idempotency_key || "create", payload, 0);
    return project(await stream(productId));
  }

  async function createRevision(productId, input = {}) {
    if (input.owner_id && input.owner_id !== owner) throw new Error("caller-selected owner is forbidden");
    const rows = await stream(clean(productId, 160));
    const current = project(rows);
    if (!current || current.owner_id !== owner) throw new Error("product not found");
    const expectedHead = clean(input.expected_head_revision_id, 160);
    const ref = clean(input.ref, 400);
    const contentHash = clean(input.content_hash || (input.content === undefined ? "" : hash(input.content)), 160);
    if (!ref || !contentHash) throw new Error("product revision requires ref and content_hash");
    const revisionId = clean(input.revision_id, 160) || `revision_${contentHash.slice(0, 32)}`;
    const revisionPayload = {
      product_id: current.product_id,
      revision_id: revisionId,
      parent_revision_id: expectedHead,
      content_hash: contentHash,
      ref,
      format: clean(input.format || current.format, 120),
      processor: clean(input.processor, 160),
      provenance_refs: Array.isArray(input.provenance_refs) ? input.provenance_refs.map((item) => clean(item, 400)).slice(0, 24) : [],
      created_at: clock(),
    };
    const revisionKey = `product:${current.product_id}:${input.idempotency_key || `revision:${revisionId}`}`;
    const prior = await existingKey(revisionKey);
    if (prior) {
      if (prior.payload?.request_fingerprint !== requestFingerprint(revisionPayload)) {
        throw new Error("product idempotency collision");
      }
      return current;
    }
    if ((current.head_revision_id || "") !== expectedHead) {
      throw new Error(`product head conflict: expected ${expectedHead || "(empty)"}, current ${current.head_revision_id || "(empty)"}`);
    }
    const revision = await append(current.product_id, "product.revision_created",
      input.idempotency_key || `revision:${revisionId}`, revisionPayload, current.version);
    await append(current.product_id, "product.head_updated",
      `${input.idempotency_key || `revision:${revisionId}`}:head`, {
        product_id: current.product_id,
        revision_id: revisionId,
        previous_revision_id: current.head_revision_id,
        revision_event_id: revision.event_id,
      }, Number(revision.stream_version));
    return project(await stream(current.product_id));
  }

  async function get(productId) {
    const value = project(await stream(clean(productId, 160)));
    return value?.owner_id === owner ? value : null;
  }

  return { createProduct, createRevision, get };
}

module.exports = { createIntentProductAuthority, PRODUCT_TYPES };

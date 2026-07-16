const OUTBOX_KEY = "ageeToolReceiptOutbox";
const LEDGER_KEY = "ageeToolExecutionLedger";
const MAX_OUTBOX = 100;
const MAX_LEDGER = 200;
const MAX_RESULT_BYTES = 64 * 1024;

function createToolReceiptRuntime({ callGateway, execute, storage, randomUUID = () => crypto.randomUUID(), now = () => new Date() }) {
  let inFlight = null;

  async function poll({ cfg, deviceId, localToolManifest }) {
    if (inFlight) return inFlight;
    inFlight = pollOnce({ cfg, deviceId, localToolManifest });
    try { return await inFlight; }
    finally { inFlight = null; }
  }

  async function pollOnce({ cfg, deviceId, localToolManifest }) {
    const device = exactId(deviceId);
    if (!device) throw new Error("Invalid browser device id.");
    await flush(cfg);
    if ((await readOutbox()).length) return { status: "receipt_retry_pending" };
    const claimed = await callGateway(cfg, "/v1/tool/requests/claim", {
      body: { device_id: device, surface_type: "browser_extension", local_tool_manifest: localToolManifest },
    });
    const request = claimed?.request;
    if (!request?.id) return { status: "idle" };
    const requestId = exactId(request.id);
    const claimId = exactId(request.claim_id);
    if (!requestId || !claimId) return { status: "invalid_claim" };
    const ledger = await readLedger();
    const prior = ledger.find((item) => item.request_id === requestId && item.claim_id === claimId);
    if (prior) {
      if (prior.status === "executing") await recoverInterrupted(prior, device);
      await flush(cfg);
      return { status: "duplicate_claim_suppressed", request_id: requestId };
    }
    const priorExecution = ledger.find((item) => item.request_id === requestId && item.status !== "late_claim");
    if (priorExecution) {
      await suppressReassigned(requestId, claimId, device);
      await flush(cfg);
      return { status: "reassigned_claim_suppressed", request_id: requestId };
    }
    if (expired(request.lease_expires_at)) {
      await writeLedger({ request_id: requestId, claim_id: claimId, receipt_id: newReceiptId(), status: "late_claim", updated_at: now().toISOString() });
      return { status: "late_claim" };
    }
    const receiptId = newReceiptId();
    await writeLedger({ request_id: requestId, claim_id: claimId, receipt_id: receiptId, status: "executing", updated_at: now().toISOString() });
    let execution;
    try { execution = await execute(request); }
    catch (error) {
      execution = {
        ok: false,
        error: text(String(error?.message || error), 1000),
        summary: "Browser local tool execution failed.",
        local_receipt: { success: false, execution_error: true },
      };
    }
    const body = canonicalReceiptBody({ device, claimId, receiptId, execution });
    await enqueue({ request_id: requestId, claim_id: claimId, receipt_id: receiptId, path: `/v1/tool/requests/${encodeURIComponent(requestId)}/receipts`, body, created_at: now().toISOString() });
    await writeLedger({ request_id: requestId, claim_id: claimId, receipt_id: receiptId, status: "executed", updated_at: now().toISOString() });
    await flush(cfg);
    return { status: "executed", request_id: requestId, receipt_id: receiptId };
  }

  async function recoverInterrupted(prior, device) {
    if ((await readOutbox()).some((item) => item.receipt_id === prior.receipt_id)) return;
    const execution = {
      ok: false,
      error: "local execution outcome unknown after browser worker interruption",
      summary: "Browser suppressed duplicate local execution after an interrupted claim.",
      local_receipt: { success: false, interrupted: true },
    };
    await enqueue({
      request_id: prior.request_id,
      claim_id: prior.claim_id,
      receipt_id: prior.receipt_id,
      path: `/v1/tool/requests/${encodeURIComponent(prior.request_id)}/receipts`,
      body: canonicalReceiptBody({ device, claimId: prior.claim_id, receiptId: prior.receipt_id, execution }),
      created_at: now().toISOString(),
    });
    await writeLedger({ ...prior, status: "execution_unknown", updated_at: now().toISOString() });
  }

  async function suppressReassigned(requestId, claimId, device) {
    const receiptId = newReceiptId();
    const execution = {
      ok: false,
      error: "request was already executed under an earlier gateway claim",
      summary: "Browser suppressed duplicate local execution after claim reassignment.",
      local_receipt: { success: false, duplicate_execution_suppressed: true },
    };
    await enqueue({
      request_id: requestId,
      claim_id: claimId,
      receipt_id: receiptId,
      path: `/v1/tool/requests/${encodeURIComponent(requestId)}/receipts`,
      body: canonicalReceiptBody({ device, claimId, receiptId, execution }),
      created_at: now().toISOString(),
    });
    await writeLedger({ request_id: requestId, claim_id: claimId, receipt_id: receiptId, status: "execution_unknown", updated_at: now().toISOString() });
  }

  async function flush(cfg) {
    for (const record of await readOutbox()) {
      try {
        await callGateway(cfg, record.path, { body: record.body });
        await removeOutbox(record.receipt_id);
        await writeLedger({ request_id: record.request_id, claim_id: record.claim_id, receipt_id: record.receipt_id, status: "receipted", updated_at: now().toISOString() });
      } catch (error) {
        if (!terminalReceiptRejection(error)) break;
        await removeOutbox(record.receipt_id);
        await writeLedger({ request_id: record.request_id, claim_id: record.claim_id, receipt_id: record.receipt_id, status: "terminal_rejected", updated_at: now().toISOString() });
      }
    }
  }

  async function enqueue(record) {
    const canonical = canonicalOutboxRecord(record);
    if (!canonical) throw new Error("Invalid browser tool receipt record.");
    const records = await readOutbox();
    const existing = records.find((item) => item.receipt_id === canonical.receipt_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(canonical)) throw new Error("Browser tool receipt identity conflict.");
      return;
    }
    if (records.length >= MAX_OUTBOX) throw new Error("Browser tool receipt queue is full; local execution was not repeated.");
    await storage.set({ [OUTBOX_KEY]: [...records, canonical] });
  }

  async function readOutbox() {
    const stored = await storage.get({ [OUTBOX_KEY]: [] });
    return (Array.isArray(stored[OUTBOX_KEY]) ? stored[OUTBOX_KEY] : []).map(canonicalOutboxRecord).filter(Boolean).slice(0, MAX_OUTBOX);
  }

  async function removeOutbox(receiptId) {
    await storage.set({ [OUTBOX_KEY]: (await readOutbox()).filter((item) => item.receipt_id !== receiptId) });
  }

  async function readLedger() {
    const stored = await storage.get({ [LEDGER_KEY]: [] });
    return (Array.isArray(stored[LEDGER_KEY]) ? stored[LEDGER_KEY] : []).map(canonicalLedgerRecord).filter(Boolean).slice(-MAX_LEDGER);
  }

  async function writeLedger(value) {
    const record = canonicalLedgerRecord(value);
    if (!record) throw new Error("Invalid browser tool execution ledger record.");
    const existing = (await readLedger()).filter((item) => !(item.request_id === record.request_id && item.claim_id === record.claim_id));
    await storage.set({ [LEDGER_KEY]: [...existing.slice(-(MAX_LEDGER - 1)), record] });
  }

  function newReceiptId() {
    const id = exactId(`btr_${randomUUID()}`);
    if (!id) throw new Error("Unable to create a browser tool receipt id.");
    return id;
  }

  function expired(value) {
    const expiry = Date.parse(String(value || ""));
    return !Number.isFinite(expiry) || now().getTime() >= expiry;
  }

  return Object.freeze({ poll });
}

function terminalReceiptRejection(error) {
  const status = Number(error?.gatewayStatus);
  if (status === 409 || status === 404 || status === 507) return true;
  if (status === 403) return /device_id does not match request (?:target|claimant)/.test(String(error?.gatewayResponseText || ""));
  return /returned 409\b/.test(String(error?.message || error));
}

function canonicalReceiptBody({ device, claimId, receiptId, execution }) {
  const result = boundedJson(execution?.result);
  const localReceipt = boundedJson(execution?.local_receipt);
  return {
    device_id: device,
    claim_id: claimId,
    receipt_id: receiptId,
    idempotency_key: receiptId,
    ok: execution?.ok === true,
    summary: text(execution?.summary, 500),
    error: text(execution?.error, 1000),
    result,
    local_receipt: localReceipt,
  };
}

function canonicalOutboxRecord(value) {
  const requestId = exactId(value?.request_id), claimId = exactId(value?.claim_id), receiptId = exactId(value?.receipt_id);
  const path = requestId ? `/v1/tool/requests/${encodeURIComponent(requestId)}/receipts` : "";
  const body = value?.body;
  if (!requestId || !claimId || !receiptId || value?.path !== path || !body || typeof body !== "object") return null;
  if (body.device_id !== exactId(body.device_id) || body.claim_id !== claimId || body.receipt_id !== receiptId || body.idempotency_key !== receiptId) return null;
  return { request_id: requestId, claim_id: claimId, receipt_id: receiptId, path, body: canonicalReceiptBody({ device: body.device_id, claimId, receiptId, execution: body }), created_at: text(value.created_at, 40) };
}

function canonicalLedgerRecord(value) {
  const requestId = exactId(value?.request_id), claimId = exactId(value?.claim_id), receiptId = exactId(value?.receipt_id);
  const status = ["executing", "executed", "execution_unknown", "receipted", "terminal_rejected", "late_claim"].includes(value?.status) ? value.status : "";
  return requestId && claimId && receiptId && status ? { request_id: requestId, claim_id: claimId, receipt_id: receiptId, status, updated_at: text(value.updated_at, 40) } : null;
}

function boundedJson(value) {
  if (value == null) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= MAX_RESULT_BYTES ? JSON.parse(serialized) : null;
  } catch { return null; }
}

function exactId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value) ? value : "";
}

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export { createToolReceiptRuntime };

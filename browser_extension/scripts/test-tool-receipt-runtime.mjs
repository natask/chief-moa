import assert from "node:assert/strict";
import test from "node:test";
import { createToolReceiptRuntime } from "../extension/tool-receipt-runtime.js";

const REQUEST = {
  id: "request_1",
  claim_id: "claim_1",
  claimed_at: "2026-07-16T00:00:00.000Z",
  lease_expires_at: "2026-07-16T00:02:30.000Z",
  tool: "browser.tab.list",
  input: {},
};

function fixture(options = {}) {
  const state = {};
  const calls = [];
  let executions = 0;
  let claimIndex = 0;
  let receiptAttempts = 0;
  let uuidCount = 0;
  let failExecutionUnknownLedger = options.failExecutionUnknownLedgerOnce === true;
  let failOutboxWrite = options.failOutboxWriteOnce === true;
  const claims = options.claims || [{ request: REQUEST }, { request: null }];
  const deps = {
    callGateway: async (_cfg, path, request = {}) => {
      calls.push({ path, body: structuredClone(request.body) });
      if (path === "/v1/tool/requests/claim") return claims[Math.min(claimIndex++, claims.length - 1)];
      receiptAttempts += 1;
      const failure = options.receiptFailure?.(receiptAttempts);
      if (failure) {
        const error = new Error(typeof failure === "string" ? failure : failure.message);
        if (typeof failure === "object") Object.assign(error, failure);
        throw error;
      }
      return { ok: true, idempotent_replay: receiptAttempts > 1 };
    },
    execute: async () => {
      executions += 1;
      if (options.executeError) throw new Error(options.executeError);
      return { ok: true, summary: "listed tabs", result: { tabs: [1] }, local_receipt: { tool: "browser.tab.list", success: true } };
    },
    storage: {
      get: async (defaults) => ({ ...defaults, ...state }),
      set: async (patch) => {
        if (failOutboxWrite && patch.ageeToolReceiptOutbox?.length) {
          failOutboxWrite = false;
          throw new Error("simulated outbox interruption");
        }
        if (failExecutionUnknownLedger && patch.ageeToolExecutionLedger?.some((item) => item.claim_id === "claim_2" && item.status === "execution_unknown")) {
          failExecutionUnknownLedger = false;
          throw new Error("simulated worker interruption");
        }
        Object.assign(state, structuredClone(patch));
      },
    },
    randomUUID: () => `fixed-receipt${uuidCount++ ? `-${uuidCount}` : ""}`,
    now: () => new Date("2026-07-16T00:00:30.000Z"),
  };
  const runtime = createToolReceiptRuntime(deps);
  return { runtime, restart: () => createToolReceiptRuntime(deps), calls, state, executions: () => executions };
}

const pollInput = { cfg: { gatewayUrl: "https://gateway.example" }, deviceId: "device_1", localToolManifest: [{ name: "browser.tab.list" }] };

test("receipt preserves the server claim id and uses one strict stable receipt identity", async () => {
  const fx = fixture();
  const result = await fx.runtime.poll(pollInput);
  assert.equal(result.status, "executed");
  assert.equal(fx.executions(), 1);
  const posted = fx.calls.find((call) => call.path.endsWith("/receipts"));
  assert.equal(posted.path, "/v1/tool/requests/request_1/receipts");
  assert.equal(posted.body.device_id, "device_1");
  assert.equal(posted.body.claim_id, "claim_1");
  assert.equal(posted.body.receipt_id, "btr_fixed-receipt");
  assert.equal(posted.body.idempotency_key, posted.body.receipt_id);
  assert.deepEqual(posted.body.result, { tabs: [1] });
});

test("transport retry reuses the exact persisted path and body without duplicate execution", async () => {
  const fx = fixture({ receiptFailure: (attempt) => attempt === 1 ? "network unavailable" : "" });
  await fx.runtime.poll(pollInput);
  const first = fx.calls.find((call) => call.path.endsWith("/receipts"));
  assert.equal(fx.state.ageeToolReceiptOutbox.length, 1);
  await fx.runtime.poll(pollInput);
  const posts = fx.calls.filter((call) => call.path.endsWith("/receipts"));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], first);
  assert.equal(fx.executions(), 1);
  assert.deepEqual(fx.state.ageeToolReceiptOutbox, []);
});

test("terminal conflict clears retry state and a late claim never executes", async () => {
  const conflict = fixture({ receiptFailure: () => "Gateway returned 409 for receipt: terminal_request" });
  await conflict.runtime.poll(pollInput);
  assert.equal(conflict.executions(), 1);
  assert.deepEqual(conflict.state.ageeToolReceiptOutbox, []);
  assert.equal(conflict.state.ageeToolExecutionLedger.at(-1).status, "terminal_rejected");

  const late = fixture({ claims: [{ request: { ...REQUEST, claim_id: "claim_late", lease_expires_at: "2026-07-16T00:00:29.999Z" } }] });
  const result = await late.runtime.poll(pollInput);
  assert.equal(result.status, "late_claim");
  assert.equal(late.executions(), 0);
  assert.equal(late.calls.some((call) => call.path.endsWith("/receipts")), false);
});

test("strict gateway terminal statuses clear retries but a recoverable auth denial stays durable", async () => {
  for (const failure of [
    { message: "missing", gatewayStatus: 404, gatewayResponseText: "tool request not found" },
    { message: "full", gatewayStatus: 507, gatewayResponseText: "receipt capacity reached" },
    { message: "mismatch", gatewayStatus: 403, gatewayResponseText: "receipt device_id does not match request claimant" },
  ]) {
    const terminal = fixture({ receiptFailure: () => failure });
    await terminal.runtime.poll(pollInput);
    assert.deepEqual(terminal.state.ageeToolReceiptOutbox, []);
    assert.equal(terminal.state.ageeToolExecutionLedger.at(-1).status, "terminal_rejected");
  }
  const recoverable = fixture({ receiptFailure: () => ({
    message: "token rejected", gatewayStatus: 403, gatewayResponseText: "missing or invalid gateway token",
  }) });
  await recoverable.runtime.poll(pollInput);
  assert.equal(recoverable.state.ageeToolReceiptOutbox.length, 1);
  assert.equal(recoverable.state.ageeToolExecutionLedger.at(-1).status, "executed");
});

test("a duplicate claimed request is never executed twice", async () => {
  const fx = fixture({ claims: [{ request: REQUEST }, { request: REQUEST }] });
  await fx.runtime.poll(pollInput);
  const duplicate = await fx.runtime.poll(pollInput);
  assert.equal(duplicate.status, "duplicate_claim_suppressed");
  assert.equal(fx.executions(), 1);
  assert.equal(fx.calls.filter((call) => call.path.endsWith("/receipts")).length, 1);
});

test("claim reassignment after a stale receipt never repeats the local action", async () => {
  const reassigned = { ...REQUEST, claim_id: "claim_2", lease_expires_at: "2026-07-16T00:03:00.000Z" };
  const fx = fixture({
    claims: [{ request: REQUEST }, { request: reassigned }],
    receiptFailure: (attempt) => attempt === 1 ? "Gateway returned 409 for receipt: stale_claim" : "",
  });
  await fx.runtime.poll(pollInput);
  const result = await fx.runtime.poll(pollInput);
  assert.equal(result.status, "reassigned_claim_suppressed");
  assert.equal(fx.executions(), 1);
  const posts = fx.calls.filter((call) => call.path.endsWith("/receipts"));
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.claim_id, "claim_2");
  assert.equal(posts[1].body.ok, false);
  assert.equal(posts[1].body.local_receipt.duplicate_execution_suppressed, true);
});

test("reassigned receipt survives interruption between outbox and ledger writes", async () => {
  const reassigned = { ...REQUEST, claim_id: "claim_2", lease_expires_at: "2026-07-16T00:03:00.000Z" };
  const fx = fixture({
    claims: [{ request: REQUEST }, { request: reassigned }, { request: reassigned }],
    receiptFailure: (attempt) => attempt === 1 ? "Gateway returned 409 for receipt: stale_claim" : "",
    failExecutionUnknownLedgerOnce: true,
  });
  await fx.runtime.poll(pollInput);
  await assert.rejects(fx.runtime.poll(pollInput), /simulated worker interruption/);
  assert.equal(fx.state.ageeToolReceiptOutbox.length, 1);
  const restarted = fx.restart();
  const result = await restarted.poll(pollInput);
  assert.equal(result.status, "duplicate_claim_suppressed");
  assert.equal(fx.executions(), 1);
  assert.deepEqual(fx.state.ageeToolReceiptOutbox, []);
  assert.equal(fx.calls.filter((call) => call.path.endsWith("/receipts")).length, 2);
});

test("worker interruption after local execution never repeats the action and reuses its reserved receipt id", async () => {
  const fx = fixture({ failOutboxWriteOnce: true, claims: [{ request: REQUEST }, { request: REQUEST }] });
  await assert.rejects(fx.runtime.poll(pollInput), /simulated outbox interruption/);
  assert.equal(fx.executions(), 1);
  assert.equal(fx.state.ageeToolExecutionLedger[0].status, "executing");
  assert.equal(fx.state.ageeToolExecutionLedger[0].receipt_id, "btr_fixed-receipt");
  const result = await fx.restart().poll(pollInput);
  assert.equal(result.status, "duplicate_claim_suppressed");
  assert.equal(fx.executions(), 1);
  const posted = fx.calls.find((call) => call.path.endsWith("/receipts"));
  assert.equal(posted.body.receipt_id, "btr_fixed-receipt");
  assert.equal(posted.body.claim_id, "claim_1");
  assert.equal(posted.body.local_receipt.interrupted, true);
});

test("a thrown local executor error becomes one stable terminal receipt", async () => {
  const fx = fixture({ executeError: "tab vanished" });
  const result = await fx.runtime.poll(pollInput);
  assert.equal(result.status, "executed");
  assert.equal(fx.executions(), 1);
  const posted = fx.calls.find((call) => call.path.endsWith("/receipts"));
  assert.equal(posted.body.ok, false);
  assert.equal(posted.body.error, "tab vanished");
  assert.equal(posted.body.idempotency_key, posted.body.receipt_id);
});

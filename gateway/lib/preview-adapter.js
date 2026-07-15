"use strict";

const { assertNoActiveCollision } = require("./preview-resource-plan");

function createPreviewAdapter({ provider, poll = {}, signal } = {}) {
  for (const method of ["create", "inspect", "health", "cleanup"]) {
    if (typeof provider?.[method] !== "function") throw new Error(`preview provider requires ${method}()`);
  }
  const attempts = Math.max(1, Math.min(Number(poll.attempts) || 10, 100));
  const intervalMs = Math.max(0, Math.min(Number(poll.interval_ms) || 1000, 30_000));
  const timeoutMs = Math.max(10, Math.min(Number(poll.operation_timeout_ms) || 30_000, 120_000));
  const sleep = poll.sleep || abortableSleep;

  async function deploy(plan, activeIdentity = {}) {
    assertNoActiveCollision(plan, activeIdentity);
    if (signal?.aborted) throw abortError();
    const existing = await operation("inspect", (operationSignal) => provider.inspect(plan, { signal: operationSignal, timeout_ms: timeoutMs }));
    if (existing?.exists) {
      validateInspection(plan, existing, activeIdentity);
      if (await operation("health", (operationSignal) => provider.health(plan, existing, { signal: operationSignal, timeout_ms: timeoutMs }))) return { plan, inspection: existing, reused: true };
    }
    let createAttempted = false;
    try {
      createAttempted = true;
      await operation("create", (operationSignal) => provider.create(plan, { signal: operationSignal, timeout_ms: timeoutMs }));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal?.aborted) throw abortError();
        const inspection = await operation("inspect", (operationSignal) => provider.inspect(plan, { signal: operationSignal, timeout_ms: timeoutMs }));
        validateInspection(plan, inspection, activeIdentity);
        if (await operation("health", (operationSignal) => provider.health(plan, inspection, { signal: operationSignal, timeout_ms: timeoutMs }))) return { plan, inspection, reused: false };
        if (attempt < attempts) await sleep(intervalMs, signal);
      }
      throw new Error("preview failed bounded health polling");
    } catch (error) {
      if (createAttempted) {
        try {
          await operation("cleanup", (operationSignal) => provider.cleanup(plan, { signal: operationSignal, timeout_ms: timeoutMs }), { ignoreParentAbort: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `preview failed and cleanup also failed: ${error.message}; ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }

  async function operation(name, invoke, { ignoreParentAbort = false } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason || abortError());
    if (!ignoreParentAbort && signal) signal.addEventListener("abort", onAbort, { once: true });
    if (!ignoreParentAbort && signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await Promise.race([
        Promise.resolve().then(() => invoke(controller.signal)),
        new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason || abortError()), { once: true })),
      ]);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  return { deploy };
}

function validateInspection(plan, inspection, activeIdentity) {
  if (!inspection || inspection.exists !== true) throw new Error("provider did not inspect an existing preview");
  for (const field of ["project", "hostname", "database", "queue", "queue_status", "storage", "worker_pool", "worker_pool_status", "image_ref", "database_image_ref", "commit_sha"]) {
    if (inspection[field] !== plan[field]) throw new Error(`provider inspection ${field} does not match the preview plan`);
  }
  assertNoActiveCollision(inspection, activeIdentity);
}

function abortError() { const error = new Error("preview deployment aborted"); error.name = "AbortError"; return error; }
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || abortError());
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const previewAdapterTestInternals = Object.freeze({ abortableSleep, abortError });

module.exports = { createPreviewAdapter, validateInspection, previewAdapterTestInternals };

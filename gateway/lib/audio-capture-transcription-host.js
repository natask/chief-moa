"use strict";

const os = require("node:os");

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_SCAN_LIMIT = 50;
const DEFAULT_BACKOFF_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function createAudioCaptureTranscriptionHost({
  captureBlocks,
  processBlock,
  enabled = false,
  workerId = defaultAudioCaptureWorkerId(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  concurrency = DEFAULT_CONCURRENCY,
  scanLimit = DEFAULT_SCAN_LIMIT,
  backoffMs = DEFAULT_BACKOFF_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  clock = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  if (!captureBlocks?.list || typeof processBlock !== "function") {
    throw new Error("capture transcription host requires capture blocks and processBlock");
  }
  const pollEvery = boundedInteger(pollIntervalMs, "poll_interval_ms", 100, 5 * 60_000);
  const concurrencyLimit = boundedInteger(concurrency, "concurrency", 1, 8);
  const scanBound = boundedInteger(scanLimit, "scan_limit", 1, 100);
  const retryBackoff = boundedInteger(backoffMs, "backoff_ms", 100, 5 * 60_000);
  const shutdownBound = boundedInteger(shutdownTimeoutMs, "shutdown_timeout_ms", 100, 60_000);
  const id = requireWorkerId(workerId);
  const inFlight = new Map();
  const retryAfter = new Map();
  let timer = null;
  let polling = false;
  let running = false;
  let stopping = false;
  let lastScan = emptyScan();
  let lastError = "";
  let lastPollAt = "";
  let processedTotal = 0;
  let completedTotal = 0;
  let failedTotal = 0;
  let shutdownTimedOut = false;
  let scanOffset = 0;

  async function poll() {
    if (!enabled || stopping || polling) return status();
    polling = true;
    lastPollAt = isoNow(clock);
    try {
      const result = await captureBlocks.list({ limit: scanBound, offset: scanOffset });
      const items = Array.isArray(result?.items) ? result.items : [];
      lastScan = summarize(items, clockMs(clock));
      scanOffset = result?.has_more === true ? scanOffset + items.length : 0;
      if (result?.has_more === true && items.length === 0) scanOffset = 0;
      const capacity = Math.max(0, concurrencyLimit - inFlight.size);
      const candidates = items.filter((block) => eligible(block, clockMs(clock)))
        .filter((block) => !inFlight.has(block.id))
        .filter((block) => (retryAfter.get(block.id) || 0) <= clockMs(clock))
        .slice(0, capacity);
      for (const block of candidates) launch(block.id);
      lastError = "";
    } catch (error) {
      lastError = cleanError(error);
      logger?.error?.(`capture transcription poll failed: ${lastError}`);
    } finally {
      polling = false;
    }
    return status();
  }

  function launch(blockId) {
    const job = Promise.resolve().then(() => processBlock(blockId)).then((block) => {
      processedTotal += 1;
      retryAfter.delete(blockId);
      if (block?.processing_state === "transcribed") completedTotal += 1;
      else if (block?.processing_state === "failed") failedTotal += 1;
      return block;
    }).catch((error) => {
      retryAfter.set(blockId, clockMs(clock) + retryBackoff);
      lastError = cleanError(error);
      logger?.warn?.(`capture transcription job ${blockId} deferred: ${lastError}`);
      return null;
    }).finally(() => inFlight.delete(blockId));
    inFlight.set(blockId, job);
  }

  function schedule() {
    if (!running || stopping) return;
    timer = setTimer(async () => {
      timer = null;
      await poll();
      schedule();
    }, pollEvery);
    timer?.unref?.();
  }

  function start() {
    if (!enabled || running || stopping) return status();
    running = true;
    Promise.resolve().then(poll).finally(schedule);
    return status();
  }

  async function stop() {
    stopping = true;
    running = false;
    if (timer) clearTimer(timer);
    timer = null;
    const jobs = [...inFlight.values()];
    if (jobs.length) {
      const drained = Promise.allSettled(jobs).then(() => true);
      const timeout = new Promise((resolve) => {
        const handle = setTimer(() => resolve(false), shutdownBound);
        handle?.unref?.();
      });
      shutdownTimedOut = !(await Promise.race([drained, timeout]));
    }
    return status();
  }

  function status() {
    return {
      enabled: Boolean(enabled),
      running,
      stopping,
      worker_id: id,
      poll_interval_ms: pollEvery,
      concurrency: concurrencyLimit,
      scan_limit: scanBound,
      backoff_ms: retryBackoff,
      in_flight: inFlight.size,
      queued_observed: lastScan.queued,
      actively_leased_observed: lastScan.transcribing,
      expired_leases_observed: lastScan.expired,
      eligible_observed: lastScan.eligible,
      scanned_observed: lastScan.scanned,
      next_scan_offset: scanOffset,
      processed_total: processedTotal,
      transcribed_total: completedTotal,
      failed_total: failedTotal,
      last_poll_at: lastPollAt || null,
      last_error: lastError || null,
      shutdown_timed_out: shutdownTimedOut,
    };
  }

  return Object.freeze({ start, stop, poll, status });
}

function eligible(block, nowMs) {
  if (block?.schema_version !== 2 || block?.source?.kind !== "audio_note") return false;
  if (block.processing_state === "queued") return true;
  return block.processing_state === "transcribing"
    && Number.isFinite(Date.parse(block.processing_claim?.lease_expires_at || ""))
    && Date.parse(block.processing_claim.lease_expires_at) <= nowMs;
}

function summarize(items, nowMs) {
  const result = emptyScan();
  result.scanned = items.length;
  for (const block of items) {
    if (block?.schema_version !== 2 || block?.source?.kind !== "audio_note") continue;
    if (block.processing_state === "queued") result.queued += 1;
    if (block.processing_state === "transcribing") {
      result.transcribing += 1;
      if (eligible(block, nowMs)) result.expired += 1;
    }
    if (eligible(block, nowMs)) result.eligible += 1;
  }
  return result;
}

function emptyScan() { return { scanned: 0, queued: 0, transcribing: 0, expired: 0, eligible: 0 }; }
function defaultAudioCaptureWorkerId() {
  return `capture-stt-${String(os.hostname() || "host").replace(/[^A-Za-z0-9._:-]/g, "-")}-${process.pid}`;
}
function requireWorkerId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error("worker_id is invalid");
  return id;
}
function boundedInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}
function isoNow(clock) {
  const date = new Date(clock());
  if (!Number.isFinite(date.getTime())) throw new Error("clock returned an invalid date");
  return date.toISOString();
}
function clockMs(clock) { return Date.parse(isoNow(clock)); }
function cleanError(error) { return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500); }

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_SCAN_LIMIT,
  createAudioCaptureTranscriptionHost,
  defaultAudioCaptureWorkerId,
  eligible,
};

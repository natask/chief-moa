#!/usr/bin/env node
"use strict";

function createPreviewPoller({ listPending, handleRequest, sleep = delay, intervalMs = 5000, signal } = {}) {
  if (typeof listPending !== "function" || typeof handleRequest !== "function") throw new Error("preview poller requires listPending and handleRequest");
  async function pollOnce() {
    if (signal?.aborted) return { stopped: true, handled: 0 };
    const requests = await listPending();
    let handled = 0;
    for (const request of requests || []) {
      if (signal?.aborted) break;
      await handleRequest(request);
      handled += 1;
    }
    return { stopped: Boolean(signal?.aborted), handled };
  }
  async function run() {
    while (!signal?.aborted) {
      await pollOnce();
      if (!signal?.aborted) await sleep(intervalMs);
    }
  }
  return { pollOnce, run };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

if (require.main === module) {
  process.stderr.write("preview-worker is an injected-runner library; configure a provider-specific launcher\n");
  process.exitCode = 2;
}

module.exports = { createPreviewPoller };

import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserCommandRuntime } from "../extension/browser-command-runtime.js";

function fixture(receipt = null) {
  const requests = [];
  const messages = [];
  const states = [];
  const runtime = createBrowserCommandRuntime({
    automation: {
      execute: async (request) => {
        requests.push(request);
        return receipt || {
          ok: true,
          summary: "Opened amazon results.",
          result: { tab_id: 12 },
          local_receipt: { tool: request.tool, success: true },
        };
      },
    },
    send: (tabId, message) => messages.push({ tabId, message }),
    saveTaskState: async (cueId, state) => states.push({ cueId, state }),
    throwIfAborted: (signal) => {
      if (signal?.aborted) throw new Error("aborted");
    },
  });
  return { runtime, requests, messages, states };
}

test("ordinary Amazon descriptions execute through the first-party search facade", async () => {
  const { runtime, requests, messages, states } = fixture();
  assert.equal(await runtime.execute(4, "find me an ergonomic red chair on Amazon", {}, "cue-1"), true);
  assert.deepEqual(requests, [{
    tool: "browser.search.open",
    input: { query: "ergonomic red chair", provider: "amazon", active: true },
  }]);
  assert.equal(messages[0].message.cmd, "done");
  assert.equal(states[0].state.openedTabId, 12);
  assert.equal(states[0].state.localReceipt.tool, "browser.search.open");
});

test("direct URLs reuse navigation and unrelated conversation falls through", async () => {
  const { runtime, requests } = fixture();
  assert.equal(await runtime.execute(4, "open example.com/docs", {}, "cue-2"), true);
  assert.deepEqual(requests[0], {
    tool: "browser.navigate",
    input: { url: "https://example.com/docs", new_tab: true, active: true },
  });
  assert.equal(await runtime.execute(4, "tell me about ergonomic chairs", {}, "cue-3"), false);
});

test("failed local commands render and persist honest error receipts", async () => {
  const { runtime, messages, states } = fixture({
    ok: false,
    error: "blocked",
    summary: "Navigation blocked.",
    local_receipt: { tool: "browser.navigate", success: false },
  });
  assert.equal(await runtime.execute(4, "open example.com", {}, "cue-4"), true);
  assert.equal(messages[0].message.cmd, "error");
  assert.equal(states[0].state.status, "error");
});

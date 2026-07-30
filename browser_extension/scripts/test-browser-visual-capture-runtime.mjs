import assert from "node:assert/strict";
import test from "node:test";
import { captureBoundTabJpeg } from "../extension/browser-visual-capture-runtime.js";

test("capture stays bound to the requested tab while browser focus changes", async () => {
  let activeTabId = 11;
  const calls = [];
  const adapter = {
    async attach(target) { calls.push(["attach", target.tabId]); },
    async send(target, method) {
      calls.push([method, target.tabId, activeTabId]);
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-22", loaderId: "loader-1", url: "https://bound.test/tasks" } } };
      }
      if (method === "Page.captureScreenshot") {
        activeTabId = 33;
        return { data: "bound-tab-jpeg" };
      }
      return {};
    },
    async detach(target) { calls.push(["detach", target.tabId]); },
  };

  assert.equal(await captureBoundTabJpeg(22, adapter), "bound-tab-jpeg");
  assert.equal(calls.every((call) => call[1] === 22), true);
  assert.equal(calls.some((call) => call[0] === "captureVisibleTab"), false);
});

test("navigation during capture rejects the pixels and still detaches", async () => {
  let identity = 0;
  let detached = false;
  const result = await captureBoundTabJpeg(7, {
    async attach() {},
    async send(_target, method) {
      if (method === "Page.getFrameTree") {
        identity += 1;
        return { frameTree: { frame: { id: "frame-7", loaderId: `loader-${identity}`, url: "https://example.test" } } };
      }
      if (method === "Page.captureScreenshot") return { data: "stale-jpeg" };
      return {};
    },
    async detach() { detached = true; },
  });
  assert.equal(result, null);
  assert.equal(detached, true);
});

test("invalid targets and debugger failures fail closed", async () => {
  let detached = false;
  assert.equal(await captureBoundTabJpeg(null, {}), null);
  assert.equal(await captureBoundTabJpeg(3, {
    async attach() { throw new Error("busy"); },
    async send() { throw new Error("must not run"); },
    async detach() { detached = true; },
  }), null);
  assert.equal(detached, false);
});

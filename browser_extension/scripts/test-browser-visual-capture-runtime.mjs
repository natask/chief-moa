import assert from "node:assert/strict";
import test from "node:test";
import { captureActiveTabJpeg, captureBoundTabJpeg } from "../extension/browser-visual-capture-runtime.js";

test("active-page capture uses the normal visible-tab API without a debugger attachment", async () => {
  const calls = [];
  const tab = { id: 22, windowId: 4, active: true, url: "https://visible.test/tasks" };
  const result = await captureActiveTabJpeg(22, {
    async getTab(tabId) { calls.push(["getTab", tabId]); return { ...tab }; },
    async captureVisibleTab(windowId, options) {
      calls.push(["captureVisibleTab", windowId, options]);
      return "data:image/jpeg;base64,dmlzaWJsZS10YWItanBlZw==";
    },
  });
  assert.equal(result, "dmlzaWJsZS10YWItanBlZw==");
  assert.deepEqual(calls[1], ["captureVisibleTab", 4, { format: "jpeg", quality: 45 }]);
  assert.equal(calls.some((call) => call[0] === "attach"), false);
});

test("active-page capture fails closed if focus or navigation changes", async () => {
  let reads = 0;
  assert.equal(await captureActiveTabJpeg(22, {
    async getTab() {
      reads += 1;
      return { id: 22, windowId: 4, active: reads === 1, url: reads === 1 ? "https://one.test" : "https://two.test" };
    },
    async captureVisibleTab() { return "data:image/jpeg;base64,c3RhbGU="; },
  }), null);
  assert.equal(await captureActiveTabJpeg(22, {
    async getTab() { return { id: 22, windowId: 4, active: false, url: "https://one.test" }; },
    async captureVisibleTab() { throw new Error("must not capture an inactive target"); },
  }), null);
});

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

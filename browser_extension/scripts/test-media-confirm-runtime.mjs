import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDetails, createMediaConfirmationRuntime } from "../extension/media-confirmation-runtime.js";

const VIDEO_ID = "dQw4w9WgXcQ";

function chromeFixture() {
  const messages = [];
  const removed = [];
  const created = [];
  const chromeApi = {
    runtime: {
      id: "test",
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => messages.push(listener) },
    },
    windows: {
      create: async (options) => { created.push(options); return { id: 12 }; },
      onRemoved: { addListener: (listener) => removed.push(listener) },
    },
  };
  return { chromeApi, created, messages, removed };
}

test("media confirmation details are bounded", () => {
  assert.deepEqual(canonicalDetails({
    operation: "remember",
    label: ` chorus ${"x".repeat(200)}`,
    note: "note",
    video_id: VIDEO_ID,
    position_seconds: 42.9,
    disclosure: "save it",
  }), {
    operation: "remember",
    label: `chorus ${"x".repeat(113)}`,
    note: "note",
    video_id: VIDEO_ID,
    position_seconds: 42,
    bookmark_id: "",
    query: "",
    title: "",
    channel: "",
    disclosure: "save it",
  });
  assert.throws(() => canonicalDetails({ operation: "open", video_id: "bad", disclosure: "open" }));
  assert.deepEqual(canonicalDetails({
    operation: "search_open",
    query: "Specific video",
    title: "Specific Video",
    channel: "Exact Channel",
    disclosure: "Search and open it?",
  }), {
    operation: "search_open",
    label: "",
    note: "",
    video_id: "",
    position_seconds: 0,
    bookmark_id: "",
    query: "Specific video",
    title: "Specific Video",
    channel: "Exact Channel",
    disclosure: "Search and open it?",
  });
  assert.throws(() => canonicalDetails({ operation: "search_open", query: "x", disclosure: "search" }));
});

test("confirmation is extension-page-bound, digest-bound, one-shot, and resolves only after allow", async () => {
  const fx = chromeFixture();
  const runtime = createMediaConfirmationRuntime({
    chromeApi: fx.chromeApi,
    now: () => Date.parse("2026-07-16T00:00:00.000Z"),
    setTimer: () => 1,
    clearTimer: () => {},
    digestDetails: async () => "digest",
  });
  const resultPromise = runtime.confirm({ operation: "open", video_id: VIDEO_ID, position_seconds: 9, disclosure: "Open it?" });
  await new Promise((resolve) => setImmediate(resolve));
  const id = fx.created[0].url.split("#")[1];
  const trusted = { id: "test", url: "chrome-extension://test/media-confirm.html" };
  assert.deepEqual(runtime.details({ url: "https://host.example/" }, { id }), { ok: false, reason: "untrusted_confirmation_surface" });
  assert.equal(runtime.details({ id: "other", url: "chrome-extension://other/media-confirm.html" }, { id }).ok, false);
  const details = runtime.details(trusted, { id });
  assert.equal(details.ok, true);
  assert.equal(details.details.video_id, VIDEO_ID);
  assert.equal(runtime.decide(trusted, { id, digest: "changed", decision: "allow" }).ok, false);
  assert.equal(runtime.pendingCount(), 1);
  assert.deepEqual(runtime.decide(trusted, { id, digest: details.digest, decision: "allow" }), { ok: true, allowed: true });
  assert.equal(await resultPromise, true);
  assert.equal(runtime.pendingCount(), 0);
  assert.equal(runtime.decide(trusted, { id, digest: details.digest, decision: "allow" }).ok, false);
});

test("closing the extension confirmation settles it as denied", async () => {
  const fx = chromeFixture();
  const runtime = createMediaConfirmationRuntime({ chromeApi: fx.chromeApi, setTimer: () => 1, clearTimer: () => {}, digestDetails: async () => "digest" });
  const resultPromise = runtime.confirm({ operation: "delete", video_id: VIDEO_ID, disclosure: "Delete it?" });
  await new Promise((resolve) => setImmediate(resolve));
  fx.removed[0](12);
  assert.equal(await resultPromise, false);
  assert.equal(runtime.pendingCount(), 0);
});

class Element {
  constructor() { this.textContent = ""; this.className = ""; this.disabled = false; this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type, isTrusted) { this.listeners.get(type)?.({ isTrusted }); }
}

test("media confirmation UI ignores synthetic clicks", async () => {
  const original = { chrome: globalThis.chrome, document: globalThis.document, location: globalThis.location, window: globalThis.window };
  const ids = ["allow", "cancel", "status", "operation", "label", "query", "title", "channel", "video-id", "position", "note", "digest", "disclosure"];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const messages = [];
  let closed = 0;
  globalThis.document = { getElementById: (id) => elements.get(id) };
  globalThis.location = { hash: "#mc_12345678-1234-4123-8123-123456789abc" };
  globalThis.window = { close: () => { closed += 1; } };
  globalThis.chrome = { runtime: { sendMessage: async (message) => {
    messages.push(message);
    return message.cmd === "mediaConfirmationDetails"
      ? { ok: true, digest: "abc", details: { operation: "open", video_id: VIDEO_ID, position_seconds: 3, disclosure: "Open?" } }
      : { ok: true };
  } } };
  await import(`../extension/media-confirm.js?test=${Math.random()}`);
  await new Promise((resolve) => setImmediate(resolve));
  elements.get("allow").emit("click", false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  elements.get("allow").emit("click", true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[1].decision, "allow");
  assert.equal(closed, 1);
  Object.assign(globalThis, original);
});

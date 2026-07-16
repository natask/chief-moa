import assert from "node:assert/strict";

await import(`../extension/content-extension-api-runtime.js?test=${Date.now()}`);
const { createContentExtensionApiRuntime } = globalThis.AgeeContentExtensionApiRuntime;

function chromeFixture(overrides = {}) {
  const runtime = {
    id: "extension-id",
    sendMessage(message) {
      assert.equal(this, runtime);
      return { echoed: message };
    },
    ...overrides.runtime,
  };
  const local = {
    get(defaults) {
      assert.equal(this, local);
      return { ...defaults, stored: true };
    },
    set(items) {
      assert.equal(this, local);
      return { saved: items };
    },
    ...overrides.local,
  };
  return { runtime, storage: { local }, ...overrides.chrome };
}

globalThis.chrome = chromeFixture();
const defaultsRuntime = createContentExtensionApiRuntime();
assert.ok(Object.isFrozen(defaultsRuntime));
assert.equal(defaultsRuntime.canCallExtensionApi(), true);
assert.equal(defaultsRuntime.isExtensionContextInvalidated(), false);
assert.deepEqual(await defaultsRuntime.safeRuntimeSendMessage({ cmd: "ping" }), { echoed: { cmd: "ping" } });
assert.deepEqual(await defaultsRuntime.safeStorageLocalGet({ fallback: true }), { fallback: true, stored: true });
assert.deepEqual(await defaultsRuntime.safeStorageLocalSet({ enabled: true }), { saved: { enabled: true } });
assert.deepEqual([...new Uint8Array(defaultsRuntime.base64ToBuffer("AQID"))], [1, 2, 3]);
assert.equal(defaultsRuntime.base64ToBuffer(null).byteLength, 0);
assert.equal(defaultsRuntime.markExtensionContextInvalidated(new Error("ordinary failure")), false);
assert.equal(defaultsRuntime.canCallExtensionApi(), true);

const missingChrome = createContentExtensionApiRuntime({ getChrome: () => undefined });
assert.equal(missingChrome.canCallExtensionApi(), false);
assert.equal(missingChrome.isExtensionContextInvalidated(), true);
globalThis.chrome = chromeFixture();
assert.equal(missingChrome.canCallExtensionApi(), false, "a stale context remains disabled");
assert.equal(await missingChrome.safeRuntimeSendMessage({ cmd: "ignored" }), null);
assert.deepEqual(await missingChrome.safeStorageLocalGet({ fallback: true }), { fallback: true });
assert.equal(await missingChrome.safeStorageLocalSet({ enabled: true }), null);

const missingRuntimeId = createContentExtensionApiRuntime({ getChrome: () => ({ runtime: {} }) });
assert.equal(missingRuntimeId.canCallExtensionApi(), false);

let getterCalls = 0;
const retryableGetter = createContentExtensionApiRuntime({
  getChrome() {
    getterCalls += 1;
    if (getterCalls === 1) throw new Error("temporary getter failure");
    return chromeFixture();
  },
});
assert.equal(retryableGetter.canCallExtensionApi(), false);
assert.equal(retryableGetter.isExtensionContextInvalidated(), false);
assert.equal(retryableGetter.canCallExtensionApi(), true, "non-context failures do not poison later calls");

const invalidatingGetter = createContentExtensionApiRuntime({
  getChrome() {
    throw new Error("Extension context invalidated.");
  },
});
assert.equal(invalidatingGetter.canCallExtensionApi(), false);
assert.equal(invalidatingGetter.isExtensionContextInvalidated(), true);
assert.equal(invalidatingGetter.canCallExtensionApi(), false);

const missingMethods = createContentExtensionApiRuntime({
  getChrome: () => ({ runtime: { id: "extension-id" }, storage: { local: {} } }),
});
assert.equal(await missingMethods.safeRuntimeSendMessage({ cmd: "missing" }), null);
assert.deepEqual(await missingMethods.safeStorageLocalGet({ fallback: true }), { fallback: true });
assert.equal(await missingMethods.safeStorageLocalSet({ enabled: true }), null);

for (const invoke of [
  (runtime) => runtime.safeRuntimeSendMessage({ cmd: "async-context" }),
  (runtime) => runtime.safeStorageLocalGet({ fallback: true }),
  (runtime) => runtime.safeStorageLocalSet({ enabled: true }),
]) {
  const contextError = new Error("context invalidated while calling Chrome");
  const chromeApi = chromeFixture({
    runtime: { sendMessage: () => Promise.reject(contextError) },
    local: {
      get: () => Promise.reject(contextError),
      set: () => Promise.reject(contextError),
    },
  });
  const runtime = createContentExtensionApiRuntime({ getChrome: () => chromeApi });
  await invoke(runtime);
  assert.equal(runtime.canCallExtensionApi(), false);
}

const asyncFailure = new Error("async failure");
for (const [runtime, invoke] of [
  [
    createContentExtensionApiRuntime({
      getChrome: () => chromeFixture({ runtime: { sendMessage: () => Promise.reject(asyncFailure) } }),
    }),
    (value) => value.safeRuntimeSendMessage({ cmd: "fail" }),
  ],
  [
    createContentExtensionApiRuntime({
      getChrome: () => chromeFixture({ local: { get: () => Promise.reject(asyncFailure) } }),
    }),
    (value) => value.safeStorageLocalGet({ fallback: true }),
  ],
  [
    createContentExtensionApiRuntime({
      getChrome: () => chromeFixture({ local: { set: () => Promise.reject(asyncFailure) } }),
    }),
    (value) => value.safeStorageLocalSet({ enabled: true }),
  ],
]) {
  await assert.rejects(() => invoke(runtime), /async failure/);
  assert.equal(runtime.canCallExtensionApi(), true);
}

const syncContext = createContentExtensionApiRuntime({
  getChrome: () => chromeFixture({ runtime: { sendMessage: () => { throw new Error("context invalidated"); } } }),
});
assert.equal(await syncContext.safeRuntimeSendMessage({ cmd: "fail" }), null);
assert.equal(syncContext.canCallExtensionApi(), false);

const syncFailure = createContentExtensionApiRuntime({
  getChrome: () => chromeFixture({ local: { get: () => { throw new Error("sync failure"); } } }),
});
await assert.rejects(() => syncFailure.safeStorageLocalGet({ fallback: true }), /sync failure/);
assert.equal(syncFailure.canCallExtensionApi(), true);

const injectedDecoder = createContentExtensionApiRuntime({
  getChrome: () => chromeFixture(),
  decodeBase64: () => "AZ",
  ByteArray: Uint8Array,
});
assert.deepEqual([...new Uint8Array(injectedDecoder.base64ToBuffer("ignored"))], [65, 90]);

console.log("content extension API runtime tests passed");

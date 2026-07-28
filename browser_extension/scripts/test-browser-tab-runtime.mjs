import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserTabRuntime, OWNED_TABS_KEY } from "../extension/browser-tab-runtime.js";

function fixture() {
  const values = {};
  const created = [];
  const removed = [];
  const liveTabs = new Map();
  let clock = Date.parse("2026-07-28T00:00:00.000Z");
  const storage = {
    get: async (defaults) => ({ ...defaults, ...values }),
    set: async (update) => Object.assign(values, update),
  };
  const runtime = createBrowserTabRuntime({
    chromeApi: {
      storage: { local: storage },
      tabs: {
        create: async (input) => {
          const tab = { id: 41, url: input.url, active: input.active };
          created.push(input); liveTabs.set(41, tab); return tab;
        },
        get: async (id) => {
          if (!liveTabs.has(id)) throw new Error("missing");
          return liveTabs.get(id);
        },
        remove: async (id) => removed.push(id),
      },
    },
    storage,
    now: () => "2026-07-28T00:00:00.000Z",
    nowMs: () => clock,
    nonce: () => "lease-nonce-1",
    leaseMs: 1000,
  });
  return { runtime, created, removed, values, liveTabs, advance: (ms) => { clock += ms; } };
}

test("explicit background tabs stay inactive and persist agent ownership", async () => {
  const { runtime, created, values } = fixture();
  const result = await runtime.open({ url: "https://example.com/", background: true, requestId: "req-1" });
  assert.deepEqual(created, [{ url: "https://example.com/", active: false }]);
  assert.equal(result.tab.active, false);
  assert.deepEqual(values[OWNED_TABS_KEY], [{
    tab_id: 41, request_id: "req-1", ownership_nonce: "lease-nonce-1",
    created_url: "https://example.com/", created_origin: "https://example.com",
    created_at: "2026-07-28T00:00:00.000Z", expires_at_ms: Date.parse("2026-07-28T00:00:01.000Z"),
  }]);
});

test("close fails closed for arbitrary tabs and removes only an owned tab", async () => {
  const { runtime, removed } = fixture();
  assert.equal((await runtime.close(7)).code, "identity_required");
  assert.deepEqual(removed, []);
  await runtime.open({ url: "https://example.com/", background: true });
  assert.equal((await runtime.close(41)).code, "identity_required");
  assert.deepEqual(await runtime.close(41, "lease-nonce-1"), { ok: true, tab_id: 41, ownership_nonce: "lease-nonce-1" });
  assert.deepEqual(removed, [41]);
  assert.equal(await runtime.isOwned(41), false);
});

test("ownership rejects wrong nonce, expiry, and stale tab-id URL reuse while clearing stale records", async () => {
  const wrong = fixture();
  await wrong.runtime.open({ url: "https://example.com/", background: true });
  assert.equal((await wrong.runtime.validate(41, "wrong")).code, "identity_mismatch");
  assert.equal(await wrong.runtime.isOwned(41), true);

  wrong.liveTabs.set(41, { id: 41, url: "https://attacker.example/", active: false });
  assert.equal((await wrong.runtime.validate(41, "lease-nonce-1")).code, "tab_identity_changed");
  assert.deepEqual(wrong.values[OWNED_TABS_KEY], []);

  const expired = fixture();
  await expired.runtime.open({ url: "https://example.com/", background: true });
  expired.advance(1001);
  assert.equal((await expired.runtime.close(41, "lease-nonce-1")).code, "lease_expired");
  assert.deepEqual(expired.values[OWNED_TABS_KEY], []);
});

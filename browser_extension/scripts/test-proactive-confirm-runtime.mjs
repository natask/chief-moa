import assert from "node:assert/strict";

class Element {
  constructor() {
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.dataset = {};
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async emit(type, event = {}) { return this.listeners.get(type)?.({ isTrusted: true, ...event }); }
}

const original = {
  chrome: globalThis.chrome,
  document: globalThis.document,
  location: globalThis.location,
  window: globalThis.window,
};
const validToken = "pc_12345678-1234-4123-8123-123456789abc";

async function scenario({ hash = `#${validToken}`, responses = [], throws = [] } = {}) {
  const ids = [
    "allow", "cancel", "status", "request-url", "request-method", "request-redirect",
    "request-content-type", "request-authorization", "request-digest", "request-body",
    "request-exclusions", "request-persistence", "background-connectivity",
  ];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const messages = [];
  let closed = 0;
  globalThis.document = { getElementById: (id) => elements.get(id) || null };
  globalThis.location = { hash };
  globalThis.window = { close() { closed += 1; } };
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (throws.length) throw throws.shift();
        return responses.shift();
      },
    },
  };
  await import(`../extension/proactive-confirm.js?scenario=${Math.random()}`);
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, messages, closed: () => closed };
}

let state = await scenario({
  responses: [{
    ok: true,
    request: {
      url: "https://api.test/action", method: "POST", redirect: "error",
      headers: { content_type: "application/json", authorization: "Bearer …" },
      bodyDigest: "sha256:abc", body: { action: "send" },
    },
    exclusions: "credentials", persistence: "one request",
    connectivityObservedAt: "now", backgroundConnectivity: "enabled",
  }, { ok: true, summary: "Delivered" }],
});
assert.equal(state.elements.get("allow").disabled, false);
assert.equal(state.elements.get("request-url").textContent, "https://api.test/action");
assert.equal(state.elements.get("request-redirect").textContent, "Blocked (fetch redirect=error)");
assert.match(state.elements.get("request-body").textContent, /send/);
assert.match(state.elements.get("background-connectivity").textContent, /ENABLED/);
await state.elements.get("allow").emit("click", { isTrusted: false });
assert.equal(state.messages.length, 1);
await state.elements.get("allow").emit("click");
assert.equal(state.messages[1].decision, "allow");
assert.equal(state.elements.get("status").textContent, "Delivered");
assert.equal(state.elements.get("status").className, "success");
await state.elements.get("cancel").emit("click");
assert.equal(state.closed(), 1);

state = await scenario({
  responses: [{ ok: true, request: { redirect: "follow" }, backgroundConnectivity: "disabled" }, { ok: true }],
});
assert.equal(state.elements.get("request-redirect").textContent, "follow");
assert.match(state.elements.get("background-connectivity").textContent, /DISABLED/);
await state.elements.get("cancel").emit("click", { isTrusted: false });
assert.equal(state.messages.length, 1);
await state.elements.get("cancel").emit("click");
assert.equal(state.messages[1].decision, "cancel");
assert.equal(state.closed(), 1);

state = await scenario({ responses: [{ ok: true }, { ok: false, reason: "denied" }] });
await state.elements.get("allow").emit("click");
assert.equal(state.elements.get("status").textContent, "denied");
assert.equal(state.elements.get("status").className, "error");

state = await scenario({ responses: [{ ok: true }], throws: [new Error("decision offline")] });
await state.elements.get("allow").emit("click");
assert.equal(state.elements.get("status").textContent, "decision offline");

state = await scenario({ hash: "#invalid" });
assert.match(state.elements.get("status").textContent, /invalid/);
await state.elements.get("cancel").emit("click");
assert.equal(state.closed(), 1);

state = await scenario({ responses: [{ ok: false, reason: "expired" }] });
assert.equal(state.elements.get("status").textContent, "expired");
state = await scenario({ responses: [null] });
assert.match(state.elements.get("status").textContent, /unavailable/);

globalThis.chrome = original.chrome;
globalThis.document = original.document;
globalThis.location = original.location;
globalThis.window = original.window;

console.log("proactive confirmation runtime tests passed");

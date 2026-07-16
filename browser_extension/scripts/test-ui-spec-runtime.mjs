import assert from "node:assert/strict";
const previousRuntime = globalThis.AgeeUiSpecRuntime;
delete globalThis.AgeeUiSpecRuntime;
await import(`../extension/ui-spec-runtime.js?test=${Date.now()}`);
const runtime = globalThis.AgeeUiSpecRuntime;

assert.equal(runtime.resolveAction("javascript:alert(1)", "bad", "fallback").action, "noop");
assert.deepEqual({ ...runtime.resolveAction("agent.run", "Summarize {value}", "", "the page") }, { action: "agent.run", prompt: "Summarize the page" });
assert.equal(runtime.resolveAction("agent.run", "x".repeat(900), "").prompt.length, 500);
assert.equal(runtime.resolveAction("voice.toggle", "", "Speak").prompt, "Speak");
assert.equal(runtime.resolveAction(null, null, null, "typed").prompt, "typed");

for (const invalid of [null, 1, {}, { version: 2, surfaces: [] }, { version: 1, surfaces: "bad" }]) {
  assert.equal(runtime.sanitize(invalid), null);
}
assert.equal(runtime.sanitize({ payload: { spec: { version: 1, surfaces: [] } } }), null);

const sanitized = runtime.sanitize({ is_customized: true, spec: { version: 1, surfaces: [{ id: "main<script>", title: "Hello\u0000 world", components: [{ type: "card", id: "card", body: "safe" }, { type: "iframe", id: "bad" }, { type: "map", id: "map", markers: [{ lat: 91, lng: 0 }, { lat: 10, lng: 20, label: "ok" }] }], controls: [{ type: "button", id: "go", action: "agent.run", prompt: "go" }, { type: "button", id: "bad", action: "eval" }] }] } });
assert.equal(sanitized.surfaces[0].id, "mainscript");
assert.equal(sanitized.surfaces[0].title, "Hello world");
assert.equal(sanitized.surfaces[0].components.length, 2);
assert.equal(sanitized.surfaces[0].components[1].markers.length, 1);
assert.equal(sanitized.surfaces[0].controls[1].action, "noop");
assert.equal("code" in sanitized, false);
assert.equal(runtime.sanitize({ spec: { version: 1, surfaces: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, components: [{ type: "card", id: `c${i}` }] })) } }).surfaces.length, 8);
assert.equal(runtime.sanitize({ spec: { version: 1, surfaces: [{ id: "s", components: Array.from({ length: 100 }, (_, i) => ({ type: "card", id: `c${i}` })), controls: Array.from({ length: 100 }, (_, i) => ({ type: "button", id: `b${i}` })) }] } }).surfaces[0].components.length, 40);
const variants = runtime.sanitize({ isCustomized: true, spec: { version: 1, surfaces: [
  null,
  { id: "" },
  {
    id: "variants",
    components: [
      null,
      { type: "unknown", id: "bad" },
      { type: "card", id: "card", text: "text", tone: "danger" },
      { type: "stat", id: "stat", title: "Title", value: 42, delta: -1, tone: "bad" },
      { type: "list", id: "empty-list", items: "bad" },
      { type: "list", id: "list", items: [null, {}, { title: "Item", body: "Detail", action: "page.describe", prompt: "Go" }] },
      { type: "map", id: "empty-map", markers: [] },
      { type: "map", id: "center-map", center: { latitude: -90, longitude: 180, name: "Edge" }, zoom: 99 },
      { type: "map", id: "marker-map", markers: [{ lat: 1, lon: 2, body: "Here" }], zoom: "bad" },
    ],
    controls: [
      null,
      { type: "bad", id: "bad" },
      { type: "button", id: "" },
      { type: "toggle", id: "toggle", checked: true },
      { type: "select", id: "select-empty", options: "bad" },
      { type: "select", id: "select", label: "", options: ["", " A ", null] },
    ],
  },
] } });
assert.equal(variants.isCustomized, true);
assert.equal(variants.surfaces.length, 1);
assert.equal(variants.surfaces[0].components.some((item) => item.id === "empty-list"), false);
assert.equal(variants.surfaces[0].components.some((item) => item.id === "empty-map"), false);
assert.equal(variants.surfaces[0].components.find((item) => item.id === "center-map").zoom, 20);
assert.equal(variants.surfaces[0].components.find((item) => item.id === "marker-map").zoom, 12);
assert.deepEqual(variants.surfaces[0].controls.find((item) => item.id === "select").options, ["A"]);
assert.equal(variants.surfaces[0].controls.find((item) => item.id === "toggle").checked, true);
assert.ok(JSON.stringify(sanitized).length <= 131072);
let surfaceReads = 0;
const oversizedSurfaces = new Proxy(Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}` })), { get(target, key, receiver) { if (/^\d+$/.test(String(key))) surfaceReads += 1; return Reflect.get(target, key, receiver); } });
runtime.sanitize({ spec: { version: 1, surfaces: oversizedSurfaces } });
assert.equal(surfaceReads, 8, "sanitizer must not traverse beyond the surface input cap");

function readBoundedArray(length, makeValue) {
  let reads = 0;
  const values = new Proxy(Array.from({ length }, (_, index) => makeValue(index)), {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { values, reads: () => reads };
}
const options = readBoundedArray(1000, (index) => `option-${index}`);
const items = readBoundedArray(1000, (index) => ({ label: `item-${index}` }));
const markers = readBoundedArray(1000, (index) => ({ lat: 10, lng: 20, label: `marker-${index}` }));
runtime.sanitize({ spec: { version: 1, surfaces: [{ id: "bounded", components: [
  { type: "list", id: "list", items: items.values },
  { type: "map", id: "map", markers: markers.values },
], controls: [{ type: "select", id: "select", options: options.values }] }] } });
assert.equal(options.reads(), 50, "select sanitizer must not traverse beyond the option cap");
assert.equal(items.reads(), 30, "list sanitizer must not traverse beyond the item cap");
assert.equal(markers.reads(), 24, "map sanitizer must not traverse beyond the marker cap");

if (previousRuntime === undefined) delete globalThis.AgeeUiSpecRuntime;
else globalThis.AgeeUiSpecRuntime = previousRuntime;

console.log("ui-spec runtime tests passed");

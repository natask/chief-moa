"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  COMPONENT_TYPES,
  CONTROL_TYPES,
  KNOWN_ACTIONS,
  SPEC_VERSION,
  createUiSpecStore,
  defaultSpec,
  normalizeSpec,
} = require("../lib/ui-spec");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-ui-spec-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spec(surface = {}) {
  return { surfaces: [{ id: "main", components: [], controls: [], ...surface }] };
}

test("defaults and exported declarative vocabulary are stable and cloned", () => {
  const first = defaultSpec();
  assert.equal(first.version, SPEC_VERSION);
  assert.deepEqual(CONTROL_TYPES, ["button", "text", "toggle", "select"]);
  assert.deepEqual(COMPONENT_TYPES, ["card", "list", "map", "stat"]);
  assert.ok(KNOWN_ACTIONS.includes("noop"));
  first.surfaces[0].title = "changed";
  assert.equal(defaultSpec().surfaces[0].title, "A.G.");
});

test("store replaces atomically, clones reads, reloads, and resets", (t) => {
  const dataDir = tempDir(t);
  const defaults = spec({ id: "default" });
  const store = createUiSpecStore({ dataDir, defaults });
  assert.equal(store.isCustomized(), false);
  assert.equal(store.effective().surfaces[0].id, "default");
  assert.equal(store.defaults().surfaces[0].id, "default");

  const incoming = spec({ id: "custom", title: "Custom" });
  const replaced = store.replace(incoming);
  replaced.surfaces[0].title = "mutated";
  assert.equal(store.effective().surfaces[0].title, "Custom");
  assert.equal(store.isCustomized(), true);
  assert.ok(fs.existsSync(store.specPath));

  const reloaded = createUiSpecStore({ dataDir, defaults });
  assert.equal(reloaded.effective().surfaces[0].id, "custom");
  assert.equal(reloaded.reset().surfaces[0].id, "default");
  assert.equal(reloaded.isCustomized(), false);
  assert.equal(fs.existsSync(reloaded.specPath), false);
  reloaded.reset();
});

test("invalid defaults and corrupt persistence fall back without blanking UI", (t) => {
  const dataDir = tempDir(t);
  const specPath = path.join(dataDir, "ui-spec.json");
  fs.writeFileSync(specPath, "{");
  let store = createUiSpecStore({ dataDir, defaults: { bad: true } });
  assert.equal(store.effective().surfaces[0].id, "command-panel");
  assert.throws(() => store.replace(null), /invalid ui spec/);
  assert.throws(() => store.replace({ surfaces: [] }), /invalid ui spec/);

  fs.writeFileSync(specPath, JSON.stringify({ surfaces: [{ id: "***" }] }));
  store = createUiSpecStore({ dataDir });
  assert.equal(store.effective().surfaces[0].id, "command-panel");
});

test("normalization rejects malformed documents and bounds surfaces", () => {
  for (const input of [null, "bad", [], {}, { surfaces: "bad" }, { surfaces: [null, 4, { id: "***" }] }]) {
    assert.equal(normalizeSpec(input), null);
  }
  const surfaces = Array.from({ length: 12 }, (_, index) => ({ id: `surface-${index}` }));
  const normalized = normalizeSpec({ version: 99, surfaces });
  assert.equal(normalized.version, SPEC_VERSION);
  assert.equal(normalized.surfaces.length, 8);
  assert.equal(normalized.surfaces[0].title, "surface-0");
  assert.deepEqual(normalized.surfaces[0].components, []);
  assert.deepEqual(normalized.surfaces[0].controls, []);
});

test("all controls normalize known data and discard executable or malformed shapes", () => {
  const controls = [
    null,
    4,
    { type: "unknown", id: "bad" },
    { type: "button", id: "***" },
    { type: "button", id: "go!", label: "Go", action: "agent.run", prompt: " run\u0000 now " },
    { type: "text", id: "text", value: 42 },
    { type: "toggle", id: "toggle", checked: true, action: "unknown" },
    { type: "toggle", id: "off", checked: "true" },
    { type: "select", id: "select", options: ["one", 4, "", "x".repeat(100)] },
    { type: "select", id: "empty" },
  ];
  const normalized = normalizeSpec(spec({ controls }));
  assert.equal(normalized.surfaces[0].controls.length, 6);
  const [button, text, toggle, off, select, empty] = normalized.surfaces[0].controls;
  assert.equal(button.id, "go");
  assert.equal(button.prompt, "run now");
  assert.equal(text.value, "42");
  assert.equal(toggle.action, "noop");
  assert.equal(toggle.checked, true);
  assert.equal(off.checked, false);
  assert.deepEqual(select.options, ["one", "x".repeat(80)]);
  assert.equal("options" in empty, false);
});

test("card and stat components sanitize fields and tones", () => {
  const components = [
    { type: "card", id: "card", title: "T\u0000itle", text: " body\n text ", tone: "GOOD" },
    { type: "stat", id: "stat", value: 42, delta: null, tone: "unsafe" },
  ];
  const normalized = normalizeSpec(spec({ title: 4, components }));
  assert.equal(normalized.surfaces[0].title, "main");
  assert.equal(normalized.surfaces[0].components[0].body, "body text");
  assert.equal(normalized.surfaces[0].components[0].tone, "good");
  assert.equal(normalized.surfaces[0].components[1].label, "stat");
  assert.equal(normalized.surfaces[0].components[1].value, "42");
  assert.equal(normalized.surfaces[0].components[1].tone, "neutral");
});

test("lists require usable bounded items and preserve only known actions", () => {
  const items = [
    null,
    4,
    {},
    { title: "First", body: "detail", action: "settings.open", prompt: "open" },
    { label: "Second", text: "text", action: "unknown", prompt: 4 },
  ];
  const normalized = normalizeSpec(spec({ components: [
    { type: "list", id: "empty", items: [] },
    { type: "list", id: "missing" },
    { type: "list", id: "list", items },
  ] }));
  assert.equal(normalized.surfaces[0].components.length, 1);
  assert.equal(normalized.surfaces[0].components[0].items.length, 2);
  assert.equal(normalized.surfaces[0].components[0].items[0].action, "settings.open");
  assert.equal("action" in normalized.surfaces[0].components[0].items[1], false);
});

test("maps normalize aliases, bounds coordinates and zoom, and infer centers", () => {
  const components = [
    { type: "map", id: "empty" },
    { type: "map", id: "center", center: { latitude: "12.1234567", longitude: "-45.7654321", name: "Here" }, zoom: 99 },
    { type: "map", id: "marker", center: { lat: 91, lng: 0 }, zoom: "bad", markers: [
      null, { lat: "bad", lng: 1 }, { lat: 10, lon: 20, label: "Point", body: "Detail" },
    ] },
    { type: "map", id: "low", center: { lat: -90, lng: -180 }, zoom: -5 },
  ];
  const normalized = normalizeSpec(spec({ components }));
  assert.equal(normalized.surfaces[0].components.length, 3);
  const [center, marker, low] = normalized.surfaces[0].components;
  assert.deepEqual(center.center, { lat: 12.123457, lng: -45.765432, label: "Here" });
  assert.equal(center.zoom, 20);
  assert.deepEqual(marker.center, { lat: 10, lng: 20, label: "Point" });
  assert.equal(marker.zoom, 12);
  assert.equal(marker.markers[0].detail, "Detail");
  assert.equal(low.zoom, 1);
});

test("component and collection bounds drop malformed overflow", () => {
  const components = Array.from({ length: 45 }, (_, index) => ({ type: "card", id: `card-${index}` }));
  components[0] = null;
  components[1] = { type: "bad", id: "bad" };
  components[2] = { type: "card", id: "***" };
  const controls = Array.from({ length: 30 }, (_, index) => ({ type: "button", id: `button-${index}` }));
  const normalized = normalizeSpec(spec({ components, controls }));
  assert.equal(normalized.surfaces[0].components.length, 37);
  assert.equal(normalized.surfaces[0].controls.length, 24);
});

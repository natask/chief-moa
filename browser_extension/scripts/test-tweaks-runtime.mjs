import assert from "node:assert/strict";

const origin = "https://example.test";
let persisted = {
  [origin]: [
    { id: "saved", name: "Saved", kind: "dark", params: {}, css: "html { color: white; }", enabled: true },
    { id: "disabled", name: "Disabled", kind: "dark", params: {}, css: "html {}", enabled: false },
    { id: "empty", name: "Empty", kind: "dark", params: {}, css: "", enabled: true },
  ],
};
const styles = new Map();

function styleElement() {
  const element = {
    id: "",
    textContent: "",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    remove() { styles.delete(this.id); },
  };
  return element;
}

const appendStyle = (element) => { styles.set(element.id, element); return element; };
const document = {
  head: { appendChild: appendStyle },
  documentElement: { appendChild: appendStyle },
  getElementById(id) { return styles.get(id) || null; },
  createElement(tag) {
    assert.equal(tag, "style");
    return styleElement();
  },
};

let messageListener = null;
const chrome = {
  storage: {
    local: {
      get(defaults, callback) { callback({ ...defaults, ageeTweaks: persisted }); },
      set(values, callback) { persisted = values.ageeTweaks; callback(); },
    },
  },
  runtime: {
    onMessage: { addListener(listener) { messageListener = listener; } },
  },
};

const original = {
  chrome: globalThis.chrome,
  document: globalThis.document,
  location: globalThis.location,
  window: globalThis.window,
};
globalThis.chrome = chrome;
globalThis.document = document;
globalThis.location = { origin, protocol: "https:" };
globalThis.window = {};

await import(`../extension/tweaks.js?test=${Date.now()}`);
await new Promise((resolve) => setImmediate(resolve));
const tweaks = globalThis.window.__ageeTweaks;
assert.ok(tweaks);
assert.ok(messageListener);
assert.equal(styles.has("agee-tweak-saved"), true);
assert.equal(styles.has("agee-tweak-disabled"), false);

assert.equal(tweaks.planTweak(""), null);
assert.equal(tweaks.planTweak("unsupported request"), null);

const planned = [
  ["hide the cookie banner", "hide", /cookie/],
  ["remove sidebar", "hide", /aside/],
  ["kill #promo", "css-selector-hide", /#promo/],
  ["font size 200px", "font-size", /72px/],
  ["font size 2px", "font-size", /8px/],
  ["make text 9x", "font-scale", /4em/],
  ["make font 0.1x", "font-scale", /0.5em/],
  ["make the font bigger", "font-scale", /1.25em/],
  ["make the text smaller", "font-scale", /0.85em/],
  ["make this page black", "black", /background: #000/],
  ["use a dark theme", "dark", /invert\(1\)/],
  ["make the page readable", "width", /720px/],
  ["set readable width 9999", "width", /1600px/],
];
for (const [instruction, kind, css] of planned) {
  const record = tweaks.planTweak(instruction);
  assert.equal(record.kind, kind, instruction);
  assert.match(record.css, css, instruction);
  assert.equal(record.enabled, true);
  assert.equal(typeof record.createdAt, "number");
}

assert.deepEqual(await tweaks.applyInstruction("do something unsupported"), {
  ok: false, error: 'No bounded tweak matched: "do something unsupported"',
});
const applied = await tweaks.applyInstruction("hide footer");
assert.equal(applied.ok, true);
assert.equal(applied.tweak.kind, "hide");
assert.equal(styles.has(`agee-tweak-${applied.tweak.id}`), true);

assert.deepEqual(await tweaks.applyRecordFromAgent(null), {
  ok: false, error: "unknown tweak kind: (none)",
});
assert.deepEqual(await tweaks.applyRecordFromAgent({ kind: "javascript", params: {} }), {
  ok: false, error: "unknown tweak kind: javascript",
});
assert.deepEqual(await tweaks.applyRecordFromAgent({ kind: "hide", params: {} }), {
  ok: false, error: "hide needs a non-empty selectors array",
});
assert.deepEqual(await tweaks.applyRecordFromAgent({ kind: "css-selector-hide", params: {} }), {
  ok: false, error: "css-selector-hide needs a selector",
});

const agentCases = [
  [{ kind: "hide", params: { selectors: [".promo", "", "#banner;{}"] } }, "Hide elements", /display: none/],
  [{ kind: "css-selector-hide", params: { selector: ".notice;{}" } }, "Hide .notice", /.notice/],
  [{ kind: "font-scale", params: { factor: "bad" } }, "Font 0.5x", /0.5em/],
  [{ kind: "font-size", params: { px: 100 } }, "Font 72px", /72px/],
  [{ kind: "width", params: { maxWidth: 10 } }, "Readable width", /320px/],
  [{ kind: "dark", params: null }, "Dark mode", /invert/],
  [{ kind: "black", params: {} }, "Black page", /#000/],
];
for (const [record, expectedName, expectedCss] of agentCases) {
  const result = await tweaks.applyRecordFromAgent(record);
  assert.equal(result.ok, true);
  assert.equal(result.tweak.name, expectedName);
  assert.match(result.tweak.css, expectedCss);
}
const custom = await tweaks.applyRecordFromAgent({
  kind: "dark", params: {}, name: `  ${"n".repeat(100)}  `,
});
assert.equal(custom.tweak.name.length, 80);

let listed = await tweaks.listTweaks();
assert.equal(listed.ok, true);
assert.equal(listed.origin, origin);
assert.ok(listed.tweaks.length >= 10);
assert.deepEqual(Object.keys(listed.tweaks[0]).sort(), ["css", "enabled", "id", "kind", "name", "params"].sort());

assert.deepEqual(await tweaks.removeTweak("missing"), { ok: false, removed: false, remaining: listed.tweaks.length });
const removed = await tweaks.removeTweak(applied.tweak.id);
assert.equal(removed.ok, true);
assert.equal(styles.has(`agee-tweak-${applied.tweak.id}`), false);
assert.deepEqual(await tweaks.clearTweaks(), { ok: true });
assert.equal((await tweaks.listTweaks()).tweaks.length, 0);

persisted = { [origin]: [{ id: "again", name: "Again", kind: "dark", params: {}, css: "html {}", enabled: true }] };
assert.equal(await tweaks.applySaved(), 1);
assert.equal(styles.has("agee-tweak-again"), true);

async function send(msg) {
  return new Promise((resolve) => {
    const result = messageListener(msg, {}, resolve);
    if (result !== true) resolve(result);
  });
}
assert.equal(messageListener(null, {}, () => {}), undefined);
assert.equal(messageListener({ cmd: "other" }, {}, () => {}), undefined);
assert.deepEqual(await send({ cmd: "tweak:ping" }), { ok: true, origin });
assert.equal((await send({ cmd: "tweak:apply", instruction: "black background" })).ok, true);
assert.equal((await send({ cmd: "tweak:applyRecord", record: { kind: "width", params: {} } })).ok, true);
assert.equal((await send({ cmd: "tweak:list" })).ok, true);
listed = await tweaks.listTweaks();
assert.equal((await send({ cmd: "tweak:status" })).applied.length, listed.tweaks.length);
assert.equal((await send({ cmd: "tweak:remove", id: listed.tweaks[0].id })).removed, true);
assert.equal((await send({ cmd: "tweak:clear" })).ok, true);
assert.equal(await send({ cmd: "tweak:unknown" }), false);

await import(`../extension/tweaks.js?duplicate=${Date.now()}`);
const originalHandle = globalThis.window.__ageeTweaks;
globalThis.window = {};
globalThis.location = { origin: "chrome://extensions", protocol: "chrome:" };
await import(`../extension/tweaks.js?unsupported=${Date.now()}`);
assert.equal(globalThis.window.__ageeTweaks, undefined);
globalThis.window = { __ageeTweaksLoaded: true, __ageeTweaks: originalHandle };
globalThis.location = { origin, protocol: "https:" };
await import(`../extension/tweaks.js?already=${Date.now()}`);
assert.equal(globalThis.window.__ageeTweaks, originalHandle);

globalThis.chrome = original.chrome;
globalThis.document = original.document;
globalThis.location = original.location;
globalThis.window = original.window;

console.log("tweaks runtime tests passed");

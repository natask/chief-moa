#!/usr/bin/env node
"use strict";

// Unit smoke for the gateway-side page-tweak validator (lib/page-tweaks.js).
// Pure functions, no server, no network. The gateway only validates a bounded
// { kind, params } record proposed by the model and hands it back to the browser
// client; it never compiles CSS or executes the tweak. These assertions lock the
// allowlist (the exact kinds tweaks.js compiles) and the params shape/bounds so
// an unknown kind or a malformed/opaque param is rejected without failing a turn.

const assert = require("node:assert");
const { validatePageTweak, TWEAK_KINDS } = require("../lib/page-tweaks");

// The allowlist must match tweaks.js compileCss exactly. If tweaks.js changes,
// this list is the single place to update on the gateway side.
assert.deepStrictEqual(
  TWEAK_KINDS.slice().sort(),
  ["black", "css-selector-hide", "dark", "font-scale", "font-size", "hide", "width"],
  "page-tweak allowlist must mirror tweaks.js kinds",
);

// hide: needs a non-empty selectors list of plain selectors.
{
  const r = validatePageTweak({ kind: "hide", params: { selectors: ["aside", "#sidebar"] }, name: "Hide sidebar" });
  assert.ok(r.ok, `valid hide must pass: ${JSON.stringify(r)}`);
  assert.deepStrictEqual(r.record.kind, "hide");
  assert.deepStrictEqual(r.record.params.selectors, ["aside", "#sidebar"]);
  assert.strictEqual(r.record.name, "Hide sidebar");
}
assert.ok(!validatePageTweak({ kind: "hide", params: { selectors: [] } }).ok, "hide with no selectors must reject");
assert.ok(!validatePageTweak({ kind: "hide", params: {} }).ok, "hide with no params must reject");
// A selector containing CSS-unsafe characters (would break out of a rule) is dropped.
assert.ok(
  !validatePageTweak({ kind: "hide", params: { selectors: ["a { } evil;"] } }).ok,
  "hide selectors with CSS-unsafe characters must reject",
);

// css-selector-hide: one plain selector.
{
  const r = validatePageTweak({ kind: "css-selector-hide", params: { selector: ".promo" } });
  assert.ok(r.ok, "valid css-selector-hide must pass");
  assert.strictEqual(r.record.params.selector, ".promo");
}
assert.ok(!validatePageTweak({ kind: "css-selector-hide", params: { selector: "" } }).ok, "empty selector must reject");
assert.ok(
  !validatePageTweak({ kind: "css-selector-hide", params: { selector: "x; } body { display:none" } }).ok,
  "css-injection selector must reject",
);

// font-scale: numeric factor clamped 0.5..4.
{
  const r = validatePageTweak({ kind: "font-scale", params: { factor: 1.25 } });
  assert.ok(r.ok && r.record.params.factor === 1.25, "font-scale must keep an in-range factor");
  assert.strictEqual(validatePageTweak({ kind: "font-scale", params: { factor: 99 } }).record.params.factor, 4, "factor clamps to 4");
  assert.strictEqual(validatePageTweak({ kind: "font-scale", params: { factor: 0.1 } }).record.params.factor, 0.5, "factor clamps to 0.5");
  assert.ok(!validatePageTweak({ kind: "font-scale", params: { factor: "big" } }).ok, "non-numeric factor rejects");
}

// font-size: numeric px clamped 8..72 and rounded.
{
  const r = validatePageTweak({ kind: "font-size", params: { px: 20 } });
  assert.ok(r.ok && r.record.params.px === 20, "font-size must keep an in-range px");
  assert.strictEqual(validatePageTweak({ kind: "font-size", params: { px: 500 } }).record.params.px, 72, "px clamps to 72");
  assert.strictEqual(validatePageTweak({ kind: "font-size", params: { px: 1 } }).record.params.px, 8, "px clamps to 8");
  assert.ok(!validatePageTweak({ kind: "font-size", params: {} }).ok, "missing px rejects");
}

// width: numeric maxWidth clamped 320..1600 and rounded.
{
  const r = validatePageTweak({ kind: "width", params: { maxWidth: 720 } });
  assert.ok(r.ok && r.record.params.maxWidth === 720, "width must keep an in-range maxWidth");
  assert.strictEqual(validatePageTweak({ kind: "width", params: { maxWidth: 9000 } }).record.params.maxWidth, 1600, "maxWidth clamps to 1600");
  assert.strictEqual(validatePageTweak({ kind: "width", params: { max_width: 100 } }).record.params.maxWidth, 320, "snake_case max_width accepted and clamps to 320");
}

// dark / black: no params required; any params ignored.
{
  const dark = validatePageTweak({ kind: "dark" });
  assert.ok(dark.ok && dark.record.kind === "dark", "dark must pass with no params");
  assert.deepStrictEqual(dark.record.params, {}, "dark record must carry empty params");
  const black = validatePageTweak({ kind: "black", params: { anything: true } });
  assert.ok(black.ok && black.record.kind === "black", "black must pass and ignore stray params");
  assert.deepStrictEqual(black.record.params, {}, "black record must carry empty params");
}

// Unknown / missing kinds reject with the supported list, never throwing.
{
  const unknown = validatePageTweak({ kind: "rename-label", params: {} });
  assert.ok(!unknown.ok, "unknown kind must reject");
  assert.ok(Array.isArray(unknown.supported_kinds) && unknown.supported_kinds.includes("hide"), "rejection must list supported kinds");
  assert.ok(!validatePageTweak({ kind: "prefill-text", params: {} }).ok, "prefill-text (not built) must reject");
  assert.ok(!validatePageTweak({ kind: "open-url", params: {} }).ok, "open-url (not a tweak) must reject");
  assert.ok(!validatePageTweak({}).ok, "missing kind must reject");
  assert.ok(!validatePageTweak(null).ok, "null input must reject");
  assert.ok(!validatePageTweak("hide").ok, "string input must reject");
}

// The model can never smuggle CSS or code: the record only ever carries kind +
// bounded params + an optional plain-text name. No css/js/style field survives.
{
  const r = validatePageTweak({ kind: "dark", css: "body{display:none}", js: "alert(1)", style: "x" });
  assert.ok(r.ok, "extra opaque fields must not fail validation");
  assert.deepStrictEqual(Object.keys(r.record).sort(), ["kind", "params"], "record must only expose kind + params (+ name)");
  assert.strictEqual(r.record.css, undefined, "no css field may pass through");
  assert.strictEqual(r.record.js, undefined, "no js field may pass through");
}

console.log("smoke-page-tweaks: ok");

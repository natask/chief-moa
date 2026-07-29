// One palette per frame.
// Contract: reference/design/overlay-2026-07-28/spec.md section 6.
//
// The overlay samples the page luminance behind the companion and flips
// data-agee-ribbon-theme. Every painted token then has to flip with it. When one
// does not, the unit paints half a dark theme and half a light one in the same
// frame — a near-black plate carrying white ink on a white page, which is what
// section 1.3 recorded and what nothing was watching for.
//
// So this is the watcher: parse ribbons.css, collect every --agee-ribbon-*
// declaration in both palette blocks, and fail when a painted token is missing
// from one block or holds the same value in both. Theme-invariant tokens are
// exempt, and the exemption list is closed — it is exactly the list section 6
// enumerates, so adding to it is a design decision someone has to write down.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extension/ribbons.css", import.meta.url), "utf8");

const DARK_SELECTOR = "#agee-root {";
const LIGHT_SELECTOR = '#agee-root[data-agee-ribbon-theme="light"] {';

// Exhaustive, per spec section 6: the capture capsule is a control, so it keeps
// an unambiguous contrast floor in both themes, and the red/green status
// colours mean the same thing on any page. Everything else flips.
const THEME_INVARIANT = new Set([
  "--agee-ribbon-capsule-plate",
  "--agee-ribbon-capsule-hairline",
  "--agee-red",
  "--agee-green",
]);

// A token is "painted" when its value names a colour anywhere in it. That
// catches shadows and gradients as well as plain fills, and it leaves the
// geometry and motion tokens (px, clamp, ms, cubic-bezier) alone — those live
// in the dark block only because it is also the base block, and they have no
// business flipping with the page.
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;

function paletteBlock(selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `ribbons.css must declare the palette block ${selector}`);
  const open = start + selector.length;
  const end = source.indexOf("}", open);
  assert.notEqual(end, -1, `unterminated palette block ${selector}`);
  return source.slice(open, end);
}

function declarations(block) {
  const found = new Map();
  for (const [, name, value] of block.matchAll(/(--agee-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    found.set(name, value.trim().toLowerCase().replace(/\s+/g, " "));
  }
  return found;
}

const dark = declarations(paletteBlock(DARK_SELECTOR));
const light = declarations(paletteBlock(LIGHT_SELECTOR));
const painted = (map) => [...map].filter(([name, value]) => COLOUR.test(value) && !THEME_INVARIANT.has(name));

test("every painted token exists in both palettes", () => {
  const missingFromLight = painted(dark).map(([name]) => name).filter((name) => !light.has(name));
  assert.deepEqual(missingFromLight, [], "painted tokens declared only in the dark palette");
  const missingFromDark = painted(light).map(([name]) => name).filter((name) => !dark.has(name));
  assert.deepEqual(missingFromDark, [], "painted tokens declared only in the light palette");
});

test("no painted token carries the same value in both palettes", () => {
  const identical = painted(dark)
    .filter(([name, value]) => light.get(name) === value)
    .map(([name, value]) => `${name}: ${value}`);
  assert.deepEqual(
    identical,
    [],
    "a token with one value in both palettes does not flip with the page; "
      + `add it to THEME_INVARIANT only if section 6 says it is invariant`,
  );
});

test("no rule outside the palette blocks hard-codes a colour", () => {
  const rules = source
    .replace(paletteBlock(DARK_SELECTOR), "")
    .replace(paletteBlock(LIGHT_SELECTOR), "");
  const literals = [];
  for (const [declaration] of rules.matchAll(/[a-z-]+\s*:\s*[^;{}]+;/gi)) {
    // Custom properties are the palette; a var() reference is the point.
    if (/^\s*--/.test(declaration)) continue;
    // A mask gradient paints nothing. Its #000 is an alpha stop — the colour
    // channel is discarded — so it is theme-free by construction.
    if (/^\s*(?:-webkit-)?mask(?:-image)?\s*:/.test(declaration)) continue;
    const withoutVars = declaration.replace(/var\([^)]*\)/g, "");
    if (COLOUR.test(withoutVars)) literals.push(declaration.trim());
  }
  assert.deepEqual(literals, [], "painted values must resolve from the theme palette, never a literal");
});

// The corrected values from spec section 6, which match Android's
// MoaRibbonTokens. Pinned so the drift that produced the half-dark unit cannot
// happen again by hand-editing one block and forgetting the other.
test("the palettes carry the Android-parity values", () => {
  for (const [name, darkValue, lightValue] of [
    ["--agee-ribbon-plate", "rgba(18, 19, 23, 0.91)", "rgba(252, 252, 253, 0.91)"],
    ["--agee-ribbon-plate-drag", "rgba(18, 19, 23, 0.69)", "rgba(252, 252, 253, 0.72)"],
    ["--agee-ribbon-ink", "#f4f4f6", "#141519"],
    ["--agee-ribbon-ink-ambient", "rgba(244, 244, 246, 0.88)", "rgba(20, 21, 25, 0.9)"],
    ["--agee-ribbon-hairline", "rgba(255, 255, 255, 0.14)", "rgba(0, 0, 0, 0.1)"],
    ["--agee-ribbon-you", "#7c8cff", "#6474e8"],
  ]) {
    assert.equal(dark.get(name), darkValue, `${name} (dark)`);
    assert.equal(light.get(name), lightValue, `${name} (light)`);
  }
});

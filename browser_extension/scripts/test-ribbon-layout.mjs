// Ribbon geometry. The load-bearing property is that an expanded ribbon grows
// AWAY from the companion, so the companion never moves and the page never
// reflows. That falls out of which edge each ribbon is anchored on, which is
// decided here.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = readFileSync(resolve(root, "extension/ribbon-layout.js"), "utf8");
const global = {};
new Function("globalThis", source)(global);
const L = global.AgeeRibbonLayout;

const launcher = (top, left = 600) => ({
  left, right: left + 62, top, bottom: top + 62, width: 62,
});
const place = (rect, width = 340) => L.ribbonPlacement({
  launcherRect: rect, viewportWidth: 1000, viewportHeight: 800, ribbonWidth: width,
});

test("both ribbons centre on the companion and share one left edge", () => {
  const result = place(launcher(400));
  // companion centre 631 - half of 340 = 461
  assert.equal(result.left, 461);
  assert.equal(result.flip, false);
});

test("the unit is clamped inside the viewport rather than spilling", () => {
  assert.equal(place(launcher(400, 970)).left, 1000 - 340 - L.EDGE);
  assert.equal(place(launcher(400, -30)).left, L.EDGE);
});

test("the upper ribbon is bottom-anchored so expanding grows upward", () => {
  const result = place(launcher(400));
  assert.equal(result.youAnchor, "bottom");
  // Collapsed top would be 400 - 8 - 28 = 364, so its bottom edge is 392.
  assert.equal(result.youTop, 364);
  assert.equal(result.youBottom, 800 - 364 - 28);
  // Applying youBottom pins the bottom edge: growth can only go up.
  assert.equal(800 - result.youBottom, result.youTop + L.HEIGHT);
});

test("the lower ribbon is top-anchored so expanding grows downward", () => {
  const result = place(launcher(400));
  assert.equal(result.replyTop, 462 + 8, "companion bottom + gap");
});

test("both ribbons flip together at the top edge and the companion stays put", () => {
  const rect = launcher(20);
  const flipped = place(rect);
  assert.equal(flipped.flip, true);
  // Reading order survives: you above reply, both below the companion.
  assert.ok(flipped.youTop < flipped.replyTop);
  assert.equal(flipped.youTop, rect.bottom + L.GAP);
  assert.equal(flipped.replyTop, rect.bottom + L.GAP * 2 + L.HEIGHT);
  // Flipped, the upper ribbon anchors by its top, because growing down is now
  // growing away from the companion.
  assert.equal(flipped.youAnchor, "top");
});

test("no flip when there is no room below either, so ribbons stay above", () => {
  // Companion near the top AND the viewport too short for two ribbons below.
  const result = L.ribbonPlacement({
    launcherRect: launcher(20), viewportWidth: 1000, viewportHeight: 140, ribbonWidth: 340,
  });
  assert.equal(result.flip, false);
});

test("popups flip above their anchor rather than being clipped", () => {
  const anchor = { left: 100, right: 300, top: 700, bottom: 740 };
  const below = L.popupPlacement({
    anchorRect: anchor, viewportWidth: 1000, viewportHeight: 800, width: 176, height: 150,
  });
  assert.equal(below.top, 700 - 150 - 6, "no room below -> open above");

  const room = L.popupPlacement({
    anchorRect: { left: 100, right: 300, top: 100, bottom: 140 },
    viewportWidth: 1000, viewportHeight: 800, width: 176, height: 150,
  });
  assert.equal(room.top, 146);
  assert.equal(room.left, 100);
});

test("right-aligned popups hang off the anchor's right edge", () => {
  const result = L.popupPlacement({
    anchorRect: { left: 500, right: 520, top: 100, bottom: 120 },
    viewportWidth: 1000, viewportHeight: 800, width: 214, height: 150, align: "right",
  });
  assert.equal(result.left, 520 - 214);
});

test("proximity is measured to the companion's edge, not its centre", () => {
  const rect = launcher(400);
  assert.equal(L.isWithinProximity(rect, rect.left + 10, rect.top + 10, 72), true, "inside");
  assert.equal(L.isWithinProximity(rect, rect.right + 40, rect.top + 10, 72), true, "just outside");
  assert.equal(L.isWithinProximity(rect, rect.right + 200, rect.top, 72), false, "far away");
});

test("theme follows what is actually behind the unit, not the OS alone", () => {
  assert.equal(L.themeForLuminance(L.relativeLuminance("rgb(255, 255, 255)")), "light");
  assert.equal(L.themeForLuminance(L.relativeLuminance("rgb(10, 11, 13)")), "dark");
  // A nearly transparent background is not what the user sees, so it is skipped
  // and the walk continues to the parent.
  assert.equal(L.relativeLuminance("rgba(255, 255, 255, 0.1)"), null);
  assert.equal(L.relativeLuminance("transparent"), null);
  assert.equal(L.relativeLuminance(""), null);
});

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

// The companion's centre line is the seam, and the sides never swap: what you
// said always starts on the line and runs right, what Ag replied always ends on
// it and runs left.
test("the boxes hang off the companion centre line in opposite directions", () => {
  const rect = launcher(400);
  const result = place(rect);
  const centre = rect.left + rect.width / 2; // 631
  assert.equal(result.youLeft, centre, "you-box left edge sits on the centre line");
  assert.equal(result.replyLeft + result.replyWidth, centre, "reply-box right edge sits on the line");
  assert.equal(result.youSeam, "left");
  assert.equal(result.replySeam, "right");
});

// The old layout mirrored a box that did not fit, which moved the exchange to
// the wrong side of the companion. The box is narrowed instead: the side a
// stream lives on is fixed, and width is what absorbs a companion near an edge.
test("a box that cannot fit is narrowed, never mirrored across the line", () => {
  const right = launcher(400, 700);
  const rightCentre = right.left + right.width / 2; // 731
  const atRight = place(right);
  assert.equal(atRight.youLeft, rightCentre, "you-box still starts on the line");
  assert.equal(atRight.youWidth, 1000 - L.EDGE - rightCentre, "and takes the room that is left");
  assert.ok(atRight.youWidth < 340, "which is narrower than the preferred width");
  assert.equal(atRight.replyWidth, 340, "the reply side had room, so it is untouched");

  const left = launcher(400, 200);
  const leftCentre = left.left + left.width / 2; // 231
  const atLeft = place(left);
  assert.equal(atLeft.replyLeft + atLeft.replyWidth, leftCentre, "reply-box still ends on the line");
  assert.equal(atLeft.replyWidth, leftCentre - L.EDGE, "narrowed to the room on its own side");
  assert.ok(atLeft.replyWidth < 340);
  assert.equal(atLeft.youWidth, 340, "the you side had room, so it is untouched");
});

// The seam is absolute: a companion dragged into a corner gets a narrow box,
// never a detached one. Sliding off the line was what made the unit look like
// it had jumped somewhere else on the screen.
test("a cornered companion narrows its box rather than leaving the line", () => {
  const rect = launcher(400, 980);
  const centre = rect.left + rect.width / 2; // 1011 -- past the edge margin
  const result = place(rect);
  assert.equal(result.youLeft, centre, "still starts exactly on the line");
  assert.ok(result.youWidth < L.MIN_WIDTH, "narrower than the preferred floor");
  assert.equal(result.youCramped, true, "and says so, so the view can react");
});

test("a viewport narrower than one box falls back to staying on screen", () => {
  const result = L.ribbonPlacement({
    launcherRect: launcher(400, 300), viewportWidth: 320, viewportHeight: 800, ribbonWidth: 340,
  });
  const centre = 300 + 62 / 2;
  assert.equal(result.youLeft, centre, "the seam holds even in a narrow viewport");
  assert.equal(result.replyLeft + result.replyWidth, centre);
});

test("the upper box is bottom-anchored so expanding grows upward", () => {
  const rect = launcher(400);
  const result = place(rect);
  assert.equal(result.youAnchor, "bottom");
  // Bottom pinned one gap above the companion: growth can only go up.
  assert.equal(800 - result.youBottom, rect.top - L.GAP);
});

test("the lower box is top-anchored so expanding grows downward", () => {
  const rect = launcher(400);
  const result = place(rect);
  assert.equal(result.replyAnchor, "top");
  assert.equal(result.replyTop, rect.bottom + L.GAP);
});

// The companion never moves and no box is repositioned to make room. A box near
// an edge gets a smaller height budget instead, and scrolls inside itself.
test("height is capped by the space on that side, not by moving the box", () => {
  const rect = launcher(400);
  const result = place(rect);
  assert.equal(result.youMaxHeight, rect.top - L.GAP - L.EDGE);
  assert.equal(result.replyMaxHeight, 800 - rect.bottom - L.GAP - L.EDGE);

  const high = launcher(30);
  const atTop = place(high);
  assert.equal(atTop.replyTop, high.bottom + L.GAP, "the reply still sits below the companion");
  assert.ok(atTop.youMaxHeight >= L.MIN_HEIGHT, "the you-box keeps at least one line");
  assert.equal(atTop.youCramped, true, "and reports that it is squeezed");
});

test("a companion at the bottom edge squeezes the reply without moving it", () => {
  const rect = launcher(720);
  const result = place(rect);
  assert.equal(result.replyTop, rect.bottom + L.GAP, "the reply stays below the companion");
  assert.ok(result.replyMaxHeight >= L.MIN_HEIGHT, "and keeps at least one line of budget");
  assert.equal(result.replyCramped, true);
  assert.ok(result.youMaxHeight > result.replyMaxHeight, "the roomy side keeps its budget");
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

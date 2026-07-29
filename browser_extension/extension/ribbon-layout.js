// Ribbon geometry: where the two ribbons sit relative to the companion, which
// edge they are anchored on, where a popup goes, and which theme the ambient
// glyphs need. Contract: reference/design/overlay-2026-07/spec.md section 3.1.
//
// Pure. Takes plain rects and numbers, returns plain numbers. No DOM reads, no
// element references — the caller measures once and applies the result, which
// is also what keeps a drag to one layout read per frame.
// Unit-tested directly: scripts/test-ribbon-layout.mjs.
(function initAgeeRibbonLayout(global) {
  "use strict";

  const EDGE = 16;   // minimum distance from any viewport edge
  const GAP = 8;     // companion <-> bubble
  // One line of the bubble: the 20px line box plus 8px padding either side.
  const HEIGHT = 36;
  // The room a stream must have before the companion may sit somewhere. These
  // are the numbers the drag boundary is derived from, and they are the floor
  // of the bubble's own clamp (spec section 5: clamp(260px, 40vw, 380px)).
  const MIN_BUBBLE_W = 260;
  const MIN_BUBBLE_H = 36;
  const MIN_WIDTH = 120;  // narrower than this and a line of text is unreadable
  const MIN_HEIGHT = 36;  // one line; the floor a box may be squeezed to

  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  // The unit's anchor is the companion. Both ribbons are laid out from its rect
  // and then clamped, so the persisted launcher position needs no migration and
  // dragging any element moves the whole unit.
  //
  // Each ribbon is anchored on the edge FURTHEST from the companion — the upper
  // one by its bottom, the lower one by its top — so an expanded ribbon grows
  // away from the companion and neither the companion nor the other ribbon
  // moves. Flipping swaps the upper ribbon to a top anchor, because once it
  // sits below the companion, growing downward is growing away.
  function ribbonPlacement({
    launcherRect,
    viewportWidth,
    viewportHeight,
    ribbonWidth,
    edge = EDGE,
    gap = GAP,
    height = HEIGHT,
  }) {
    const rect = launcherRect || { left: 0, right: 0, top: 0, bottom: 0, width: 0 };
    const width = Number(ribbonWidth) || 0;
    const centerX = rect.left + (rect.width || 0) / 2;
    // The two boxes hang off the companion's centre line in opposite
    // directions: what you said starts at the line and runs right, what Ag
    // replied ends at the line and runs left. The line is the seam, so the pair
    // reads as one exchange pivoting on the companion rather than as two bars
    // stacked on top of each other. Clamping can pull a box off the line near a
    // viewport edge — staying on screen wins over staying on the seam.
    // The sides are FIXED: what you said always starts on the line and runs
    // right; what Ag replied always ends on the line and runs left. A box that
    // does not fit is made narrower — it never mirrors to the other side and
    // never slides off the line. Mirroring kept the box a constant width but
    // moved the exchange to the wrong side of the companion, which read as the
    // unit jumping around when the mascot was dragged near an edge.
    // The seam is absolute. A box takes the room available on its own side,
    // preferring MIN_WIDTH but never sliding off the line to get it — dragging
    // the companion into a corner makes its box narrow, not detached. The
    // cramped flags below let the presentation react (wrap to more lines).
    const youRoom = Math.max(0, viewportWidth - edge - centerX);
    const replyRoom = Math.max(0, centerX - edge);
    const fit = (room) => Math.max(1, Math.min(width, room < MIN_WIDTH ? room : Math.max(MIN_WIDTH, room)));
    const youWidth = fit(youRoom);
    const replyWidth = fit(replyRoom);
    const youLeft = centerX;
    const replyLeft = centerX - replyWidth;

    // Vertical: the companion does not move, and neither box is repositioned to
    // make room. Each is given the height actually available on its own side of
    // the companion and grows away from it, so a long turn expands into free
    // space instead of pushing the mascot or crossing it.
    const youMaxHeight = Math.max(MIN_HEIGHT, rect.top - gap - edge);
    const replyMaxHeight = Math.max(MIN_HEIGHT, viewportHeight - rect.bottom - gap - edge);
    // Anchored on the edge furthest from the companion, so growth is away from
    // it: the upper box is pinned by its bottom, the lower by its top.
    // Both are pinned to the companion unconditionally. Clamping these to the
    // viewport is what used to slide a box up into the mascot at the bottom
    // edge; the height budget above absorbs that instead.
    const youBottom = Math.max(edge, viewportHeight - rect.top + gap);
    const replyTop = rect.bottom + gap;

    return {
      youLeft,
      replyLeft,
      youWidth,
      replyWidth,
      // Which edge sits on the line. The text inside anchors to that edge, so
      // the words always sit against the companion rather than at the far end
      // of the box.
      youSeam: "left",
      replySeam: "right",
      youMaxHeight,
      replyMaxHeight,
      youBottom,
      youAnchor: "bottom",
      replyTop,
      replyAnchor: "top",
      // True when a side is squeezed to its floor. The caller may nudge the
      // companion for the composer case; the ribbons themselves never move it.
      youCramped: rect.top - gap - edge < MIN_HEIGHT || youRoom < MIN_WIDTH,
      replyCramped: viewportHeight - rect.bottom - gap - edge < MIN_HEIGHT || replyRoom < MIN_WIDTH,
    };
  }

  // Where the companion is ALLOWED to be.
  //
  // The boxes used to absorb a cornered companion by getting narrower, which is
  // how a drag into the corner produced a 30px-wide box. The constraint belongs
  // on the companion instead: it may only be placed where both streams still
  // have their minimum room. Everything here is derived from the same tokens
  // the boxes are laid out with, so the two can never disagree.
  //
  // Returns the permitted range for the companion's top-left corner. A viewport
  // too small to satisfy the minimums collapses to a single legal point rather
  // than reporting an empty range, so a clamp always yields something on screen.
  function launcherBounds({
    viewportWidth,
    viewportHeight,
    launcherWidth,
    launcherHeight,
    minBubbleWidth = MIN_BUBBLE_W,
    minBubbleHeight = MIN_BUBBLE_H,
    edge = EDGE,
    gap = GAP,
  }) {
    const w = Number(launcherWidth) || 0;
    const h = Number(launcherHeight) || 0;
    // Horizontal: the centre line is the seam, so each side needs its own room.
    // Expressed against the left corner, which is what drag code carries.
    const minCentreX = edge + minBubbleWidth;
    const maxCentreX = viewportWidth - edge - minBubbleWidth;
    const minLeft = minCentreX - w / 2;
    const maxLeft = maxCentreX - w / 2;
    // Vertical: the you-box lives above and the reply below, each needing a
    // bubble plus its gap.
    const minTop = edge + minBubbleHeight + gap;
    const maxTop = viewportHeight - edge - minBubbleHeight - gap - h;
    return {
      minLeft,
      maxLeft: Math.max(minLeft, maxLeft),
      minTop,
      maxTop: Math.max(minTop, maxTop),
    };
  }

  // Clamp a proposed companion position into the permitted range. Applied while
  // dragging AND on resize, so a window that shrinks pulls the companion back
  // rather than stranding it somewhere its boxes cannot fit.
  function clampLauncher(left, top, bounds) {
    return {
      left: clamp(left, bounds.minLeft, bounds.maxLeft),
      top: clamp(top, bounds.minTop, bounds.maxTop),
    };
  }

  // Popups flip to stay inside the viewport instead of being clipped by it.
  function popupPlacement({
    anchorRect,
    viewportWidth,
    viewportHeight,
    width,
    height,
    align = "left",
    edge = EDGE,
    offset = 6,
  }) {
    const rect = anchorRect || { left: 0, right: 0, top: 0, bottom: 0 };
    const desiredLeft = align === "right" ? rect.right - width : rect.left;
    const left = clamp(desiredLeft, edge, Math.max(edge, viewportWidth - width - edge));
    let top = rect.bottom + offset;
    if (top + height > viewportHeight - edge) top = rect.top - height - offset;
    return { left, top: Math.max(edge, top) };
  }

  // Whether a pointer is close enough to pre-light the dormant companion.
  // Browser-only: Android has no hover (see parity.md).
  function isWithinProximity(rect, x, y, radius) {
    if (!rect) return false;
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    return Math.hypot(dx, dy) < radius;
  }

  // The plate is translucent and the shadow falls on page content, so
  // prefers-color-scheme alone is wrong on a light page in a dark OS: what
  // matters is what is actually behind the unit. Returns relative luminance
  // 0..1, or null when the colour is absent or too transparent to be what the
  // user actually sees.
  function relativeLuminance(color) {
    const match = String(color || "").match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
    const [r, g, b] = parts;
    const alpha = parts.length > 3 ? parts[3] : 1;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !(alpha > 0.2)) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function themeForLuminance(luminance) {
    return Number(luminance) >= 0.55 ? "light" : "dark";
  }

  global.AgeeRibbonLayout = Object.freeze({
    EDGE,
    GAP,
    HEIGHT,
    MIN_WIDTH,
    MIN_HEIGHT,
    MIN_BUBBLE_W,
    MIN_BUBBLE_H,
    launcherBounds,
    clampLauncher,
    isWithinProximity,
    popupPlacement,
    relativeLuminance,
    ribbonPlacement,
    themeForLuminance,
  });
})(globalThis);

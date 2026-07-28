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
  const GAP = 8;     // companion <-> ribbon
  const HEIGHT = 28; // collapsed ribbon height

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
    const left = clamp(centerX - width / 2, edge, Math.max(edge, viewportWidth - width - edge));

    const aboveTop = rect.top - gap - height;
    const belowSecondBottom = rect.bottom + gap * 2 + height * 2;
    const flip = aboveTop < edge && belowSecondBottom <= viewportHeight - edge;
    // Near the bottom edge, a below-companion reply would be clamped into the
    // mascot. Stack both streams above it instead, with the reply closest to
    // the companion. This keeps the companion visually anchoring the unit.
    const stackAbove = !flip && rect.bottom + gap + height > viewportHeight - edge;

    const clampTop = (value) => clamp(value, edge, Math.max(edge, viewportHeight - height - edge));
    const youTop = clampTop(flip
      ? rect.bottom + gap
      : stackAbove ? rect.top - gap * 2 - height * 2 : aboveTop);
    const replyTop = clampTop(flip
      ? rect.bottom + gap * 2 + height
      : stackAbove ? aboveTop : rect.bottom + gap);

    return {
      flip,
      stackAbove,
      left,
      youTop,
      replyTop,
      // Applied instead of youTop when not flipped, so the upper ribbon grows up.
      youBottom: Math.max(edge, viewportHeight - youTop - height),
      youAnchor: flip ? "top" : "bottom",
      replyBottom: Math.max(edge, viewportHeight - replyTop - height),
      replyAnchor: stackAbove ? "bottom" : "top",
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

  // The ambient state paints no plate, so the glyphs sit directly on page
  // content and prefers-color-scheme alone is wrong on a light page in a dark
  // OS. Returns relative luminance 0..1, or null when the colour is absent or
  // too transparent to be what the user actually sees.
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
    isWithinProximity,
    popupPlacement,
    relativeLuminance,
    ribbonPlacement,
    themeForLuminance,
  });
})(globalThis);

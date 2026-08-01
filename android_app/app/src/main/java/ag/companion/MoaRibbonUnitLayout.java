package ag.companion;

/**
 * Places the three windows of the overlay unit from one anchor.
 *
 * The user's requirement is "I should be able to move any item and the whole
 * unit moves as one". On Android the unit is three separate WindowManager
 * windows, so "as one" is not free — it is this function: every element's
 * position is derived from the companion's stored x/y, so a drag writes one
 * anchor and all three windows follow in the same coalesced frame.
 *
 * Two rules differ from the older card geometry in
 * {@link MoaOrbOverlayGeometry#anchoredSurface}:
 *
 * <ul>
 *   <li>The companion never moves to make room. The old card pushed the orb down
 *       when it would not fit; moving the user's companion under their own text
 *       is surprising. The ribbons flip instead — they are 28dp, they can.</li>
 *   <li>Both ribbons flip together and keep you-then-reply reading order, so the
 *       unit reads the same upside down.</li>
 * </ul>
 *
 * Pure Java: no Android types, no measurement, no side effects.
 */
final class MoaRibbonUnitLayout {

    static final class Placement {
        final int companionX;
        final int companionY;
        /** You-bubble left edge: the companion centerline, clamped inward. */
        final int youX;
        /** Reply-bubble left edge: right edge at the centerline, clamped inward. */
        final int replyX;
        final int youY;
        final int replyY;
        /** True when both ribbons sit below the companion. */
        final boolean flippedDown;
        /** True when both ribbons sit above the companion. */
        final boolean flippedUp;

        Placement(int companionX, int companionY, int youX, int replyX, int youY, int replyY,
                  boolean flippedDown, boolean flippedUp) {
            this.companionX = companionX;
            this.companionY = companionY;
            this.youX = youX;
            this.replyX = replyX;
            this.youY = youY;
            this.replyY = replyY;
            this.flippedDown = flippedDown;
            this.flippedUp = flippedUp;
        }

        boolean flipped() {
            return flippedDown || flippedUp;
        }
    }

    private MoaRibbonUnitLayout() {
    }

    /**
     * Resting layout: you-ribbon above the companion, reply-ribbon below it.
     *
     * @param safeTop    status bar / cutout inset
     * @param safeBottom navigation bar / gesture inset
     */
    static Placement place(
            int screenWidth,
            int screenHeight,
            int margin,
            int gap,
            int safeTop,
            int safeBottom,
            int companionX,
            int companionY,
            int companionSize,
            int ribbonWidth,
            int ribbonHeight
    ) {
        return place(screenWidth, screenHeight, margin, gap, safeTop, safeBottom,
                companionX, companionY, companionSize, ribbonWidth, ribbonHeight, ribbonHeight);
    }

    /**
     * Placement when the two ribbons have different heights, which happens only
     * while one of them is expanded by a tap.
     */
    static Placement place(
            int screenWidth,
            int screenHeight,
            int margin,
            int gap,
            int safeTop,
            int safeBottom,
            int companionX,
            int companionY,
            int companionSize,
            int ribbonWidth,
            int youHeight,
            int replyHeight
    ) {
        int companionCenterX = companionX + companionSize / 2;
        int minX = ribbonWidth + margin * 2 <= screenWidth ? margin : 0;
        int maxX = Math.max(minX, screenWidth - ribbonWidth - minX);
        // Chat-style diagonal: the you-bubble hangs to the RIGHT of the
        // centerline (left edge on it), the reply-bubble hangs to the LEFT
        // (right edge on it). Narrow screens clamp both inward rather than
        // letting either bubble paint past the edge margin.
        int youX = clamp(companionCenterX, minX, maxX);
        int replyX = clamp(companionCenterX - ribbonWidth, minX, maxX);

        int top = margin + Math.max(0, safeTop);
        int bottom = screenHeight - margin - Math.max(0, safeBottom);

        int youY = companionY - gap - youHeight;
        int replyY = companionY + companionSize + gap;

        boolean flippedDown = false;
        boolean flippedUp = false;
        if (youY < top) {
            // No room above: stack both below, you first so reading order holds.
            flippedDown = true;
            youY = companionY + companionSize + gap;
            replyY = youY + gap + youHeight;
        } else if (replyY + replyHeight > bottom) {
            // No room below: stack both above, reply nearest the companion so the
            // pair still reads you-then-reply top to bottom.
            flippedUp = true;
            replyY = companionY - gap - replyHeight;
            youY = replyY - gap - youHeight;
        }

        // A flip can still overrun on a very short screen; clamp rather than let a
        // ribbon paint off-screen or under the status bar.
        youY = clamp(youY, top, Math.max(top, bottom - youHeight));
        replyY = clamp(replyY, top, Math.max(top, bottom - replyHeight));

        return new Placement(
                companionX, companionY, youX, replyX, youY, replyY, flippedDown, flippedUp);
    }

    /**
     * Where the companion lands for a drag delta. Placement is respected exactly;
     * the unit never snaps to an edge, it is only clamped by the edge margin.
     */
    static int dragCompanionX(int startX, int dx, int screenWidth, int companionSize, int margin) {
        return clamp(startX + dx, margin, Math.max(margin, screenWidth - companionSize - margin));
    }

    static int dragCompanionY(int startY, int dy, int screenHeight, int companionSize, int margin) {
        return clamp(startY + dy, margin, Math.max(margin, screenHeight - companionSize - margin));
    }

    /** Total resting footprint of the unit. The overlay must never exceed this. */
    static int unitHeight(int companionSize, int gap, int ribbonHeight) {
        return ribbonHeight + gap + companionSize + gap + ribbonHeight;
    }

    /**
     * Vertical scroll offset inside an expanded bubble, in pixels from the top of
     * the content. Never past the tail, never before the head.
     */
    static int clampScroll(int scrollY, int contentHeight, int viewportHeight) {
        return clamp(scrollY, 0, Math.max(0, contentHeight - viewportHeight));
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
}

package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaRibbonUnitLayoutTest {
    private static final int SCREEN_W = 1080;
    private static final int SCREEN_H = 2340;
    private static final int MARGIN = 48;
    private static final int GAP = 24;
    private static final int COMPANION = 288;
    private static final int RIBBON_W = 600;
    private static final int RIBBON_H = 84;

    /** Narrow enough that the diagonal offsets fit unclamped on this screen. */
    private static final int RIBBON_NARROW_W = 300;

    private MoaRibbonUnitLayout.Placement place(int companionX, int companionY) {
        return MoaRibbonUnitLayout.place(
                SCREEN_W, SCREEN_H, MARGIN, GAP, 0, 0,
                companionX, companionY, COMPANION, RIBBON_W, RIBBON_H);
    }

    private MoaRibbonUnitLayout.Placement placeNarrow(int companionX, int companionY) {
        return MoaRibbonUnitLayout.place(
                SCREEN_W, SCREEN_H, MARGIN, GAP, 0, 0,
                companionX, companionY, COMPANION, RIBBON_NARROW_W, RIBBON_H);
    }

    @Test
    public void youSitsAboveAndReplySitsBelowTheCompanion() {
        MoaRibbonUnitLayout.Placement placement = place(400, 1000);

        assertEquals(1000 - GAP - RIBBON_H, placement.youY);
        assertEquals(1000 + COMPANION + GAP, placement.replyY);
        assertFalse(placement.flipped());
    }

    @Test
    public void youBubbleHangsRightWithItsLeftEdgeOnTheCenterline() {
        MoaRibbonUnitLayout.Placement placement = placeNarrow(400, 1000);

        int companionCenter = 400 + COMPANION / 2;
        assertEquals(companionCenter, placement.youX);
    }

    @Test
    public void replyBubbleHangsLeftWithItsRightEdgeOnTheCenterline() {
        MoaRibbonUnitLayout.Placement placement = placeNarrow(400, 1000);

        int companionCenter = 400 + COMPANION / 2;
        assertEquals(companionCenter, placement.replyX + RIBBON_NARROW_W);
    }

    @Test
    public void theWholeUnitMovesAsOneWhenTheAnchorMoves() {
        MoaRibbonUnitLayout.Placement before = placeNarrow(400, 1000);
        MoaRibbonUnitLayout.Placement after = placeNarrow(400 + 60, 1000 + 90);

        // Every element is derived from the companion anchor, so a drag delta
        // applies identically to all three windows. This is what "I should be
        // able to move any item and the whole unit moves as one" means when the
        // unit is three separate WindowManager windows.
        assertEquals(60, after.companionX - before.companionX);
        assertEquals(60, after.youX - before.youX);
        assertEquals(60, after.replyX - before.replyX);
        assertEquals(90, after.youY - before.youY);
        assertEquals(90, after.replyY - before.replyY);
        assertEquals(after.replyY - after.youY, before.replyY - before.youY);
    }

    @Test
    public void ribbonsFlipBelowRatherThanPushingTheCompanionDown() {
        int companionY = MARGIN + 4;
        MoaRibbonUnitLayout.Placement placement = place(400, companionY);

        // The old card moved the ORB down to make room. Moving the user's own
        // companion under their text is surprising; the 28dp ribbons flip.
        assertEquals(companionY, placement.companionY);
        assertTrue(placement.flippedDown);
        assertEquals(companionY + COMPANION + GAP, placement.youY);
        assertEquals(placement.youY + GAP + RIBBON_H, placement.replyY);
    }

    @Test
    public void flippedRibbonsKeepYouThenReplyReadingOrder() {
        MoaRibbonUnitLayout.Placement down = place(400, MARGIN);
        assertTrue(down.youY < down.replyY);

        MoaRibbonUnitLayout.Placement up = place(400, SCREEN_H - COMPANION - MARGIN);
        assertTrue(up.flippedUp);
        assertTrue(up.youY < up.replyY);
        assertEquals(up.youY + GAP + RIBBON_H, up.replyY);
    }

    @Test
    public void bothRibbonsFlipTogetherAtTheBottomEdge() {
        int companionY = SCREEN_H - COMPANION - MARGIN;
        MoaRibbonUnitLayout.Placement placement = place(400, companionY);

        assertEquals(companionY, placement.companionY);
        assertTrue(placement.replyY + RIBBON_H <= companionY);
    }

    @Test
    public void ribbonsStayInsideTheEdgeMargin() {
        MoaRibbonUnitLayout.Placement left = place(0, 1000);
        MoaRibbonUnitLayout.Placement right = place(SCREEN_W - COMPANION, 1000);

        assertTrue(left.youX >= MARGIN);
        assertTrue(left.replyX >= MARGIN);
        assertTrue(right.youX + RIBBON_W <= SCREEN_W - MARGIN);
        assertTrue(right.replyX + RIBBON_W <= SCREEN_W - MARGIN);
    }

    @Test
    public void wideBubblesClampInwardInsteadOfCentring() {
        // A 600px bubble on a 1080px screen cannot honour both diagonal edges;
        // the rule is clamp INWARD, never paint past the margin, never crash.
        MoaRibbonUnitLayout.Placement placement = place(400, 1000);
        int companionCenter = 400 + COMPANION / 2;

        assertTrue(placement.youX <= companionCenter);
        assertTrue(placement.youX + RIBBON_W <= SCREEN_W - MARGIN);
        assertTrue(placement.replyX + RIBBON_W >= companionCenter);
        assertTrue(placement.replyX >= MARGIN);
    }

    @Test
    public void aBubbleWiderThanTheScreenStillStaysOnIt() {
        MoaRibbonUnitLayout.Placement placement = MoaRibbonUnitLayout.place(
                500, SCREEN_H, MARGIN, GAP, 0, 0,
                100, 1000, COMPANION, 600, RIBBON_H);

        assertTrue(placement.youX >= 0);
        assertTrue(placement.replyX >= 0);
        assertEquals(placement.youX, placement.replyX);
    }

    @Test
    public void systemInsetsPushTheFlipTestNotTheCompanion() {
        int statusBar = 120;
        int companionY = MARGIN + 40;
        MoaRibbonUnitLayout.Placement placement = MoaRibbonUnitLayout.place(
                SCREEN_W, SCREEN_H, MARGIN, GAP, statusBar, 0,
                400, companionY, COMPANION, RIBBON_W, RIBBON_H);

        assertEquals(companionY, placement.companionY);
        assertTrue(placement.flippedDown);
        assertTrue(placement.youY >= MARGIN + statusBar);
    }

    @Test
    public void dragRespectsPlacementExactlyAndNeverSnapsToAnEdge() {
        int x = MoaRibbonUnitLayout.dragCompanionX(400, 37, SCREEN_W, COMPANION, MARGIN);
        int y = MoaRibbonUnitLayout.dragCompanionY(1000, -53, SCREEN_H, COMPANION, MARGIN);

        assertEquals(437, x);
        assertEquals(947, y);
    }

    @Test
    public void dragIsClampedOnlyByTheEdgeMargin() {
        assertEquals(MARGIN, MoaRibbonUnitLayout.dragCompanionX(400, -9999, SCREEN_W, COMPANION, MARGIN));
        assertEquals(SCREEN_W - COMPANION - MARGIN,
                MoaRibbonUnitLayout.dragCompanionX(400, 9999, SCREEN_W, COMPANION, MARGIN));
        assertEquals(MARGIN, MoaRibbonUnitLayout.dragCompanionY(1000, -9999, SCREEN_H, COMPANION, MARGIN));
        assertEquals(SCREEN_H - COMPANION - MARGIN,
                MoaRibbonUnitLayout.dragCompanionY(1000, 9999, SCREEN_H, COMPANION, MARGIN));
    }

    @Test
    public void anExpandedRibbonGrowsOnlyDownwardFromItsOwnEdge() {
        int expanded = RIBBON_H * 4;
        MoaRibbonUnitLayout.Placement placement = MoaRibbonUnitLayout.place(
                SCREEN_W, SCREEN_H, MARGIN, GAP, 0, 0,
                400, 1000, COMPANION, RIBBON_W, expanded, RIBBON_H);

        // The you-ribbon sits above the companion, so a taller one has to start
        // higher; the companion itself still does not move.
        assertEquals(1000, placement.companionY);
        assertEquals(1000 - GAP - expanded, placement.youY);
        assertEquals(1000 + COMPANION + GAP, placement.replyY);
    }

    @Test
    public void anExpandedRibbonStillCannotLeaveTheScreen() {
        int expanded = RIBBON_H * 6;
        MoaRibbonUnitLayout.Placement placement = MoaRibbonUnitLayout.place(
                SCREEN_W, SCREEN_H, MARGIN, GAP, 0, 0,
                400, MARGIN, COMPANION, RIBBON_W, expanded, RIBBON_H);

        assertTrue(placement.youY >= MARGIN);
        assertTrue(placement.youY + expanded <= SCREEN_H - MARGIN);
        assertTrue(placement.flippedDown);
    }

    @Test
    public void theUnitsRestingFootprintIsFixed() {
        // No stream delta, no reply length, nothing may change this number.
        assertEquals(RIBBON_H + GAP + COMPANION + GAP + RIBBON_H,
                MoaRibbonUnitLayout.unitHeight(COMPANION, GAP, RIBBON_H));
    }

    @Test
    public void collapsedAndExpandedLineCountsAreFixed() {
        assertEquals(1, MoaRibbonTokens.COLLAPSED_MAX_LINES);
        assertEquals(3, MoaRibbonTokens.EXPANDED_MAX_LINES);
    }

    @Test
    public void expandedScrollIsClampedToTheContent() {
        // Content 1000, viewport 400: legal offsets are 0..600.
        assertEquals(0, MoaRibbonUnitLayout.clampScroll(-50, 1000, 400));
        assertEquals(250, MoaRibbonUnitLayout.clampScroll(250, 1000, 400));
        assertEquals(600, MoaRibbonUnitLayout.clampScroll(9999, 1000, 400));
        // Content that fits cannot scroll at all.
        assertEquals(0, MoaRibbonUnitLayout.clampScroll(120, 300, 400));
    }

    @Test
    public void aFlippedUnitNeverPaintsOffScreen() {
        for (int companionY = 0; companionY <= SCREEN_H - COMPANION; companionY += 37) {
            MoaRibbonUnitLayout.Placement placement = place(400, companionY);
            assertTrue("youY=" + placement.youY, placement.youY >= MARGIN);
            assertTrue("replyY=" + placement.replyY, placement.replyY >= MARGIN);
            assertTrue(placement.youY + RIBBON_H <= SCREEN_H - MARGIN);
            assertTrue(placement.replyY + RIBBON_H <= SCREEN_H - MARGIN);
        }
    }
}

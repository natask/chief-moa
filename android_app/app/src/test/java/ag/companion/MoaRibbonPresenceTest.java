package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaRibbonPresenceTest {

    @Test
    public void restingStateIsDormant() {
        MoaRibbonPresence presence = new MoaRibbonPresence();

        assertSame(MoaRibbonPresence.State.DORMANT, presence.state(1000));
    }

    @Test
    public void streamingTextIsAmbientAndPaintsACompactBubble() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setStreaming(true);

        assertSame(MoaRibbonPresence.State.AMBIENT, presence.state(1000));
        assertEquals(0.92f, MoaRibbonPresence.plateAlpha(MoaRibbonPresence.State.AMBIENT, false), 0.001f);
        assertFalse(MoaRibbonPresence.scrimVisible(MoaRibbonPresence.State.AMBIENT, false));
    }

    @Test
    public void pressingSolidifies() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setPointerDown(true);

        assertSame(MoaRibbonPresence.State.ENGAGED, presence.state(1000));
        assertEquals(1f, MoaRibbonPresence.plateAlpha(MoaRibbonPresence.State.ENGAGED, false), 0f);
        assertTrue(MoaRibbonPresence.railVisible(MoaRibbonPresence.State.ENGAGED));
    }

    @Test
    public void draggingOutranksEveryOtherState() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setStreaming(true);
        presence.setDragging(true);

        assertSame(MoaRibbonPresence.State.DRAGGING, presence.state(1000));
        assertEquals(0.70f, MoaRibbonPresence.plateAlpha(MoaRibbonPresence.State.DRAGGING, false), 0.001f);
    }

    @Test
    public void tapLatchesEngagedThenReleasesOnItsOwn() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.latch(1000);

        assertSame(MoaRibbonPresence.State.ENGAGED, presence.state(1000 + MoaRibbonTokens.DUR_LATCH_MS - 1));
        // Past the latch with no stream and no linger, the unit goes back to
        // being basically invisible without the user doing anything.
        assertSame(MoaRibbonPresence.State.DORMANT, presence.state(1000 + MoaRibbonTokens.DUR_LATCH_MS));
    }

    @Test
    public void latchIsReleasedEarlyOnDemand() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.latch(1000);
        presence.releaseLatch();

        assertFalse(presence.latched(1001));
        assertSame(MoaRibbonPresence.State.DORMANT, presence.state(1001));
    }

    @Test
    public void anOpenMenuHoldsEngaged() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setMenuOpen(true);

        assertSame(MoaRibbonPresence.State.ENGAGED, presence.state(9_999_999));
    }

    @Test
    public void lingerKeepsAFinishedTurnReadableThenFades() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setStreaming(false);
        presence.startLinger(1000, MoaRibbonTokens.LINGER_REPLY_MS);

        assertSame(MoaRibbonPresence.State.AMBIENT, presence.state(1000 + MoaRibbonTokens.LINGER_REPLY_MS - 1));
        assertSame(MoaRibbonPresence.State.DORMANT, presence.state(1000 + MoaRibbonTokens.LINGER_REPLY_MS));
    }

    @Test
    public void anEngagedRibbonDoesNotStartItsLingerTimer() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setPointerDown(true);
        presence.startLinger(1000, MoaRibbonTokens.LINGER_REPLY_MS);

        assertEquals(0, presence.lingerDeadlineMs());
    }

    @Test
    public void anUnreadReplyLingersLongerThanASpokenOne() {
        assertEquals(MoaRibbonTokens.LINGER_YOU_MS, MoaRibbonPresence.lingerFor(false, false));
        assertEquals(MoaRibbonTokens.LINGER_REPLY_MS, MoaRibbonPresence.lingerFor(true, false));
        assertEquals(MoaRibbonTokens.LINGER_UNREAD_MS, MoaRibbonPresence.lingerFor(true, true));
    }

    @Test
    public void reducedTransparencyMakesTheAmbientBubbleFullyOpaque() {
        assertEquals(0.92f, MoaRibbonPresence.plateAlpha(MoaRibbonPresence.State.AMBIENT, false), 0.001f);
        assertEquals(1f, MoaRibbonPresence.plateAlpha(MoaRibbonPresence.State.AMBIENT, true), 0.001f);
        assertFalse(MoaRibbonPresence.scrimVisible(MoaRibbonPresence.State.AMBIENT, true));
    }

    @Test
    public void companionIsNearlyInvisibleAtRestAndFullyLitWhenTouched() {
        assertEquals(MoaOrbPresentation.IDLE_ALPHA,
                MoaRibbonPresence.companionAlpha(MoaRibbonPresence.State.DORMANT), 0.001f);
        assertEquals(0.92f, MoaRibbonPresence.companionAlpha(MoaRibbonPresence.State.AMBIENT), 0.001f);
        assertEquals(1f, MoaRibbonPresence.companionAlpha(MoaRibbonPresence.State.ENGAGED), 0f);
        assertEquals(1f, MoaRibbonPresence.companionAlpha(MoaRibbonPresence.State.DRAGGING), 0f);
    }

    @Test
    public void anEmptyDormantRibbonTakesNoTouchAtAll() {
        assertFalse(MoaRibbonPresence.acceptsTouch(MoaRibbonPresence.State.DORMANT, false));
        assertFalse(MoaRibbonPresence.acceptsTouch(MoaRibbonPresence.State.AMBIENT, false));
        assertTrue(MoaRibbonPresence.acceptsTouch(MoaRibbonPresence.State.AMBIENT, true));
        assertTrue(MoaRibbonPresence.acceptsTouch(MoaRibbonPresence.State.ENGAGED, false));
    }

    @Test
    public void railHidesEverywhereExceptEngaged() {
        assertFalse(MoaRibbonPresence.railVisible(MoaRibbonPresence.State.DORMANT));
        assertFalse(MoaRibbonPresence.railVisible(MoaRibbonPresence.State.AMBIENT));
        assertFalse(MoaRibbonPresence.railVisible(MoaRibbonPresence.State.DRAGGING));
        assertTrue(MoaRibbonPresence.railVisible(MoaRibbonPresence.State.ENGAGED));
    }

    @Test
    public void tapExpandingHoldsEngagedUntilItIsClosed() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setExpanded(true);

        // Click-to-expand outlives the latch: an open ribbon stays solid while
        // the user is reading it, however long that takes.
        assertTrue(presence.expanded());
        assertSame(MoaRibbonPresence.State.ENGAGED, presence.state(9_999_999));

        presence.setExpanded(false);
        assertSame(MoaRibbonPresence.State.DORMANT, presence.state(9_999_999));
    }

    @Test
    public void losingTheTextAlsoCollapsesTheExpandedRibbon() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.setExpanded(true);
        presence.setHasText(false);

        assertFalse(presence.expanded());
        assertSame(MoaRibbonPresence.State.DORMANT, presence.state(1000));
    }

    @Test
    public void clearingTextClearsTheLingerWithIt() {
        MoaRibbonPresence presence = new MoaRibbonPresence();
        presence.setHasText(true);
        presence.startLinger(1000, MoaRibbonTokens.LINGER_REPLY_MS);
        presence.setHasText(false);

        assertSame(MoaRibbonPresence.State.DORMANT, presence.state(1001));
    }
}

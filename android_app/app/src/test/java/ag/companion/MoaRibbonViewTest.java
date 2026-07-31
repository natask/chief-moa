package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * View-level tests for the dark-user-plate + compact-control contract: the
 * you-bubble keeps its persistent Copy and History rail whenever it holds
 * text, the reply bubble keeps its rails behind engagement/expansion as
 * before, and the geometry, touch, and accessibility contracts still hold.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 26)
public final class MoaRibbonViewTest {

    private static final int WIDTH = 700;
    private static final String LONG_TEXT =
            "This is a deliberately long user message that would wrap across "
                    + "several lines inside the bounded compact bubble viewport.";

    private final AtomicInteger sink = new AtomicInteger();

    private Runnable noop() {
        return sink::incrementAndGet;
    }

    private Application context() {
        return RuntimeEnvironment.getApplication();
    }

    private MoaRibbonView laidOut(boolean reply, String text) {
        MoaRibbonView view = new MoaRibbonView(context(), reply);
        view.setContentWidth(WIDTH);
        view.setFullText(text);
        relayout(view);
        return view;
    }

    private void relayout(MoaRibbonView view) {
        view.measure(
                View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        view.layout(0, 0, view.getMeasuredWidth(), view.getMeasuredHeight());
    }

    private int railHitWidthPx() {
        float density = context().getResources().getDisplayMetrics().density;
        return Math.round(MoaRibbonTokens.RAIL_HIT_W_DP * density);
    }

    private int railGlyphWidthPx() {
        float density = context().getResources().getDisplayMetrics().density;
        return Math.round((MoaRibbonTokens.RAIL_GLYPH_DP + 4) * density);
    }

    // --- Persistent rails on the you-bubble; gated rails on the reply -------

    @Test
    public void collapsedUserBubbleShowsPersistentCopyAndHistoryRail() {
        MoaRibbonView you = laidOut(false, LONG_TEXT);
        float mid = you.ribbonHeightPx() / 2f;

        assertTrue("copy is persistent on the you-bubble even collapsed",
                you.hitsRail(WIDTH - 1, mid));
        assertTrue("history is persistent on the you-bubble even collapsed",
                you.hitsHistory(WIDTH - railHitWidthPx() - 1, mid));
    }

    @Test
    public void replyBubbleCopyWaitsForEngagementHistoryWaitsForExpansion() {
        MoaRibbonView reply = laidOut(true, LONG_TEXT);
        float mid = reply.ribbonHeightPx() / 2f;

        assertFalse("dormant reply carries no copy rail", reply.hitsRail(WIDTH - 1, mid));
        assertFalse("dormant reply carries no history rail",
                reply.hitsHistory(WIDTH - railHitWidthPx() - 1, mid));

        reply.setPresenceState(MoaRibbonPresence.State.ENGAGED);
        assertTrue("engagement reveals the copy rail", reply.hitsRail(WIDTH - 1, mid));
        assertFalse("history still withheld until expansion",
                reply.hitsHistory(WIDTH - railHitWidthPx() - 1, mid));
        assertFalse("Copy is only at the right edge, not mid-bubble",
                reply.hitsRail(WIDTH / 2f, mid));

        reply.setExpanded(true);
        relayout(reply);
        assertTrue("expansion also reveals history",
                reply.hitsHistory(WIDTH - railHitWidthPx() - 1, mid));
    }

    // --- Geometry: each revealed rail narrows the wrapped-text viewport -----

    @Test
    public void replyBubbleViewportNarrowsByOneRailPerRevealedAffordance() {
        MoaRibbonView reply = new MoaRibbonView(context(), true);
        reply.setContentWidth(WIDTH);
        reply.setFullText(LONG_TEXT);

        int dormantViewport = reply.textViewportWidthPx();
        reply.setPresenceState(MoaRibbonPresence.State.ENGAGED);
        int engagedViewport = reply.textViewportWidthPx();
        reply.setExpanded(true);
        int expandedViewport = reply.textViewportWidthPx();

        assertEquals("the copy rail narrows the viewport by exactly one rail width",
                railGlyphWidthPx(), dormantViewport - engagedViewport);
        assertEquals("the history rail narrows the viewport by exactly one more rail width",
                railGlyphWidthPx(), engagedViewport - expandedViewport);
    }

    @Test
    public void youBubbleViewportAlreadyAccountsForBothPersistentRails() {
        MoaRibbonView you = new MoaRibbonView(context(), false);
        you.setContentWidth(WIDTH);
        you.setFullText(LONG_TEXT);

        int collapsedViewport = you.textViewportWidthPx();
        you.setExpanded(true);
        int expandedViewport = you.textViewportWidthPx();

        assertEquals("both rails are already visible collapsed, so expanding "
                        + "the you-bubble does not change the text viewport",
                collapsedViewport, expandedViewport);
    }

    @Test
    public void emptyRibbonKeepsTheBaselineCompactHeight() {
        MoaRibbonView empty = new MoaRibbonView(context(), false);
        empty.setContentWidth(WIDTH);

        assertEquals(empty.ribbonHeightPx(), empty.desiredHeightPx());
    }

    // --- Touch safety preserved --------------------------------------------

    @Test
    public void emptyDormantRibbonStaysInertWhileTextIsTouchable() {
        MoaRibbonView empty = laidOut(false, "");
        assertFalse("empty dormant ribbon lets the app underneath keep its touch",
                empty.hitsInteractive(WIDTH / 2f, empty.ribbonHeightPx() / 2f));

        MoaRibbonView withText = laidOut(false, LONG_TEXT);
        assertTrue("a bubble holding text takes its own touches",
                withText.hitsInteractive(WIDTH / 2f, withText.ribbonHeightPx() / 2f));
    }

    // --- Accessibility ------------------------------------------------------

    @Test
    public void youBubbleAdvertisesPersistentCopyAndHistoryActionsWhileCollapsed() {
        MoaRibbonView you = laidOut(false, LONG_TEXT);
        AtomicInteger copies = new AtomicInteger();
        AtomicInteger histories = new AtomicInteger();
        you.setAccessibilityActions(noop(), copies::incrementAndGet, histories::incrementAndGet);

        AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain();
        you.onInitializeAccessibilityNodeInfo(info);
        int copyAction = actionId(info, "Copy");
        int historyAction = actionId(info, "History");

        assertTrue("you-bubble Copy is persistent even collapsed", copyAction != 0);
        assertTrue("you-bubble History is persistent even collapsed", historyAction != 0);
        assertTrue(you.performAccessibilityAction(copyAction, null));
        assertTrue(you.performAccessibilityAction(historyAction, null));
        assertEquals(1, copies.get());
        assertEquals(1, histories.get());
        String label = String.valueOf(info.getContentDescription());
        assertTrue(label.contains("Copy and History buttons are at the right edge"));
        info.recycle();
    }

    @Test
    public void collapsedReplyBubbleAdvertisesNeitherCopyNorHistory() {
        MoaRibbonView reply = laidOut(true, LONG_TEXT);
        reply.setAccessibilityActions(noop(), noop(), noop());

        AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain();
        reply.onInitializeAccessibilityNodeInfo(info);

        assertTrue("tap-to-expand is advertised", actionId(info, "Expand") != 0);
        assertEquals("no Copy action before engagement", 0, actionId(info, "Copy"));
        assertEquals("no History action before expansion", 0, actionId(info, "History"));
        info.recycle();
    }

    @Test
    public void engagedThenExpandedReplyBubbleAddsCopyThenHistoryActions() {
        MoaRibbonView reply = laidOut(true, LONG_TEXT);
        AtomicInteger copies = new AtomicInteger();
        AtomicInteger histories = new AtomicInteger();
        reply.setAccessibilityActions(noop(), copies::incrementAndGet, histories::incrementAndGet);
        reply.setPresenceState(MoaRibbonPresence.State.ENGAGED);

        AccessibilityNodeInfo engagedInfo = AccessibilityNodeInfo.obtain();
        reply.onInitializeAccessibilityNodeInfo(engagedInfo);
        int copyAction = actionId(engagedInfo, "Copy");
        assertTrue("engagement exposes a Copy action", copyAction != 0);
        assertEquals("History still withheld before expansion",
                0, actionId(engagedInfo, "History"));
        assertTrue(reply.performAccessibilityAction(copyAction, null));
        assertEquals(1, copies.get());
        engagedInfo.recycle();

        reply.setExpanded(true);
        AccessibilityNodeInfo expandedInfo = AccessibilityNodeInfo.obtain();
        reply.onInitializeAccessibilityNodeInfo(expandedInfo);
        int historyAction = actionId(expandedInfo, "History");
        assertTrue("expansion exposes a History action", historyAction != 0);
        assertTrue(reply.performAccessibilityAction(historyAction, null));
        assertEquals(1, histories.get());
        expandedInfo.recycle();
    }

    @Test
    public void clickActionRunsTheTapRunnable() {
        MoaRibbonView you = laidOut(false, LONG_TEXT);
        AtomicInteger taps = new AtomicInteger();
        you.setAccessibilityActions(taps::incrementAndGet, noop(), noop());

        assertTrue(you.performAccessibilityAction(
                AccessibilityNodeInfo.ACTION_CLICK, null));
        assertEquals(1, taps.get());
    }

    private static int actionId(AccessibilityNodeInfo info, String label) {
        for (AccessibilityNodeInfo.AccessibilityAction action : info.getActionList()) {
            if (label.contentEquals(action.getLabel())) {
                return action.getId();
            }
        }
        return 0;
    }
}

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
 * View-level tests for the dark-user-plate + compact-control contract.
 * Collapsed streaming work stays bounded to the visible tail, while Copy and
 * History remain in the full app rather than consuming overlay space.
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
        view.setWindowText(text);
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

    @Test
    public void compactBubbleExposesNoCopyOrHistoryRail() {
        MoaRibbonView you = laidOut(false, LONG_TEXT);
        float mid = you.ribbonHeightPx() / 2f;

        assertFalse(you.hitsRail(WIDTH - 1, mid));
        assertFalse(you.hitsHistory(WIDTH - 1, mid));
        you.setPresenceState(MoaRibbonPresence.State.ENGAGED);
        you.setExpanded(true);
        assertFalse(you.hitsRail(WIDTH - 1, mid));
        assertFalse(you.hitsHistory(WIDTH - 1, mid));
    }

    @Test
    public void expansionDoesNotChangeTheTextViewportWidth() {
        MoaRibbonView you = new MoaRibbonView(context(), false);
        you.setContentWidth(WIDTH);
        you.setWindowText(LONG_TEXT);
        you.setFullText(LONG_TEXT);

        int collapsedViewport = you.textViewportWidthPx();
        you.setExpanded(true);
        int expandedViewport = you.textViewportWidthPx();

        assertEquals(collapsedViewport, expandedViewport);
    }

    @Test
    public void collapsedLayoutUsesBoundedTailAndExpansionUsesFullTurn() {
        MoaRibbonView you = new MoaRibbonView(context(), false);
        you.setContentWidth(WIDTH);
        you.setWindowText("short tail");
        you.setFullText((LONG_TEXT + " ").repeat(24));
        int collapsedHeight = you.desiredHeightPx();

        you.setExpanded(true);
        int expandedHeight = you.desiredHeightPx();

        assertEquals(you.ribbonHeightPx(), collapsedHeight);
        assertTrue(expandedHeight > collapsedHeight);
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
    public void compactBubbleAdvertisesNoCopyOrHistoryActions() {
        MoaRibbonView you = laidOut(false, LONG_TEXT);
        AtomicInteger copies = new AtomicInteger();
        AtomicInteger histories = new AtomicInteger();
        you.setAccessibilityActions(noop(), copies::incrementAndGet, histories::incrementAndGet);

        AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain();
        you.onInitializeAccessibilityNodeInfo(info);
        int copyAction = actionId(info, "Copy");
        int historyAction = actionId(info, "History");

        assertEquals(0, copyAction);
        assertEquals(0, historyAction);
        assertEquals(0, copies.get());
        assertEquals(0, histories.get());
        String label = String.valueOf(info.getContentDescription());
        assertFalse(label.contains("Copy"));
        assertFalse(label.contains("History"));
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
    public void engagedAndExpandedReplyStillExposesNoCompactActions() {
        MoaRibbonView reply = laidOut(true, LONG_TEXT);
        AtomicInteger copies = new AtomicInteger();
        AtomicInteger histories = new AtomicInteger();
        reply.setAccessibilityActions(noop(), copies::incrementAndGet, histories::incrementAndGet);
        reply.setPresenceState(MoaRibbonPresence.State.ENGAGED);

        AccessibilityNodeInfo engagedInfo = AccessibilityNodeInfo.obtain();
        reply.onInitializeAccessibilityNodeInfo(engagedInfo);
        assertEquals(0, actionId(engagedInfo, "Copy"));
        assertEquals(0, actionId(engagedInfo, "History"));
        engagedInfo.recycle();

        reply.setExpanded(true);
        AccessibilityNodeInfo expandedInfo = AccessibilityNodeInfo.obtain();
        reply.onInitializeAccessibilityNodeInfo(expandedInfo);
        assertEquals(0, actionId(expandedInfo, "Copy"));
        assertEquals(0, actionId(expandedInfo, "History"));
        assertEquals(0, copies.get());
        assertEquals(0, histories.get());
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

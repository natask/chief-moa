package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaWindowInsetPolicyTest {

    @Test
    public void theStatusBarAloneAnswersOnADeviceWithNoCutout() {
        assertEquals(63, MoaWindowInsetPolicy.legacyTop(63, 0));
    }

    @Test
    public void aTallerCutoutWins() {
        // FLAG_LAYOUT_NO_LIMITS lets the companion window extend into a notch, so
        // on API 28-29 the system window inset can under-report what the modern
        // statusBars() | displayCutout() request would have returned.
        assertEquals(96, MoaWindowInsetPolicy.legacyTop(63, 96));
    }

    @Test
    public void aCutoutInsideTheStatusBarChangesNothing() {
        // The normal case: the cutout sits within the status bar strip, so taking
        // the maximum is a no-op rather than double counting.
        assertEquals(63, MoaWindowInsetPolicy.legacyTop(63, 40));
    }

    @Test
    public void aHiddenStatusBarReportsNoInset() {
        // An immersive app below the overlay reports zero, exactly as
        // getInsets(statusBars()) does on API 30+. The unit must not leave a
        // phantom gap where no bar is drawn.
        assertEquals(0, MoaWindowInsetPolicy.legacyTop(0, 0));
    }

    @Test
    public void theNavigationBarIsTheWholeBottomAnswer() {
        assertEquals(48, MoaWindowInsetPolicy.legacyBottom(48));
        // Gesture navigation: a thin handle, or none at all.
        assertEquals(0, MoaWindowInsetPolicy.legacyBottom(0));
    }

    @Test
    public void negativeInsetsAreNeverPropagated() {
        // A negative inset would push a ribbon off-screen. Nothing should ever
        // report one, but the placement maths must not be handed one either.
        assertEquals(0, MoaWindowInsetPolicy.legacyTop(-10, -20));
        assertEquals(0, MoaWindowInsetPolicy.legacyBottom(-5));
        assertEquals(30, MoaWindowInsetPolicy.legacyTop(-10, 30));
    }

    @Test
    public void theInsetsFeedThePlacementRuleUnchanged() {
        // The whole point of getting these right: they are what keeps the unit
        // clear of the system bars. A wrong fallback is a placement bug, not a
        // crash, which is why it is worth pinning.
        int top = MoaWindowInsetPolicy.legacyTop(63, 96);
        int bottom = MoaWindowInsetPolicy.legacyBottom(48);
        MoaRibbonUnitLayout.Placement placement = MoaRibbonUnitLayout.place(
                1080, 2340, 48, 24, top, bottom, 400, 600, 288, 600, 84);

        assertTrue("youY=" + placement.youY, placement.youY >= 48 + top);
        assertTrue("replyY=" + placement.replyY, placement.replyY + 84 <= 2340 - 48 - bottom);
    }
}

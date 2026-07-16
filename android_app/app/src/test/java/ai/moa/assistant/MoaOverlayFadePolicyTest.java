package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

// The outside-tap fade contract: a tap outside the lion + chat/transcript
// family fades the family without closing anything; the first touch on a faded
// family window restores full opacity and is consumed. One physical gesture is
// reported by several overlay windows (ACTION_DOWN on the touched one,
// ACTION_OUTSIDE on its siblings) in no guaranteed order, so the policy
// correlates reports by event time.
public final class MoaOverlayFadePolicyTest {
    @Test
    public void outsideTapFadesAfterConfirm() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();

        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertFalse(policy.isFaded());
        assertTrue(policy.confirmFade(1000));
        assertTrue(policy.isFaded());
    }

    @Test
    public void familyTouchFirstIgnoresSameGestureOutsideReport() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();
        MoaOverlayFadePolicy.WindowGate panel = policy.newWindowGate();

        // The panel's ACTION_DOWN processes before a sibling window's
        // ACTION_OUTSIDE for the same gesture (same event time).
        assertEquals(
                MoaOverlayFadePolicy.Action.PASS,
                panel.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 1000));
        assertFalse(policy.shouldScheduleFadeConfirm(1000));
        assertFalse(policy.isFaded());
    }

    @Test
    public void outsideReportFirstIsVoidedBySameGestureFamilyTouch() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();
        MoaOverlayFadePolicy.WindowGate panel = policy.newWindowGate();

        // The sibling's ACTION_OUTSIDE processes first, then the touched family
        // window's ACTION_DOWN arrives for the same gesture.
        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertEquals(
                MoaOverlayFadePolicy.Action.PASS,
                panel.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 1000));
        assertFalse(policy.confirmFade(1000));
        assertFalse(policy.isFaded());
    }

    @Test
    public void fadedFamilyTouchRestoresAndConsumesWholeGesture() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();
        MoaOverlayFadePolicy.WindowGate orb = policy.newWindowGate();
        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertTrue(policy.confirmFade(1000));

        // The wake tap restores opacity and never reaches the orb's own gesture
        // logic — down, move, and up are all swallowed.
        assertEquals(
                MoaOverlayFadePolicy.Action.RESTORE_AND_CONSUME,
                orb.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 2000));
        assertFalse(policy.isFaded());
        assertEquals(
                MoaOverlayFadePolicy.Action.CONSUME,
                orb.onTouch(MoaOverlayFadePolicy.TouchKind.MOVE, 2010));
        assertEquals(
                MoaOverlayFadePolicy.Action.CONSUME,
                orb.onTouch(MoaOverlayFadePolicy.TouchKind.UP, 2020));

        // The next gesture on the restored family is normal interaction.
        assertEquals(
                MoaOverlayFadePolicy.Action.PASS,
                orb.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 3000));
    }

    @Test
    public void consumedGestureEndsOnCancelToo() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();
        MoaOverlayFadePolicy.WindowGate card = policy.newWindowGate();
        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertTrue(policy.confirmFade(1000));

        assertEquals(
                MoaOverlayFadePolicy.Action.RESTORE_AND_CONSUME,
                card.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 2000));
        assertEquals(
                MoaOverlayFadePolicy.Action.CONSUME,
                card.onTouch(MoaOverlayFadePolicy.TouchKind.CANCEL, 2010));
        assertEquals(
                MoaOverlayFadePolicy.Action.PASS,
                card.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 3000));
    }

    @Test
    public void staleConfirmIsSupersededByNewerOutsideGesture() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();

        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertTrue(policy.shouldScheduleFadeConfirm(1500));
        assertFalse(policy.confirmFade(1000));
        assertFalse(policy.isFaded());
        assertTrue(policy.confirmFade(1500));
        assertTrue(policy.isFaded());
    }

    @Test
    public void outsideTapWhileFadedDoesNotRefade() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();
        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertTrue(policy.confirmFade(1000));

        // Another outside tap while already dim: nothing to animate again.
        assertTrue(policy.shouldScheduleFadeConfirm(2000));
        assertFalse(policy.confirmFade(2000));
        assertTrue(policy.isFaded());
    }

    @Test
    public void programmaticRestoreClearsPendingFade() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();

        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        // A surface opens (e.g. voice starts) before the confirm fires.
        assertFalse(policy.restore());
        assertFalse(policy.confirmFade(1000));
        assertFalse(policy.isFaded());
    }

    @Test
    public void programmaticRestoreReportsWhetherItWoke() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();
        assertFalse(policy.restore());

        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertTrue(policy.confirmFade(1000));
        assertTrue(policy.restore());
        assertFalse(policy.isFaded());
    }

    @Test
    public void gatesShareOneFamilyFadeState() {
        MoaOverlayFadePolicy policy = new MoaOverlayFadePolicy();
        MoaOverlayFadePolicy.WindowGate orb = policy.newWindowGate();
        MoaOverlayFadePolicy.WindowGate panel = policy.newWindowGate();
        assertTrue(policy.shouldScheduleFadeConfirm(1000));
        assertTrue(policy.confirmFade(1000));

        // Waking through the panel restores the whole family, so a following
        // orb touch is normal interaction, not another wake.
        assertEquals(
                MoaOverlayFadePolicy.Action.RESTORE_AND_CONSUME,
                panel.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 2000));
        assertEquals(
                MoaOverlayFadePolicy.Action.PASS,
                orb.onTouch(MoaOverlayFadePolicy.TouchKind.DOWN, 3000));
    }
}

package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

// Start-button placement: the lion centers exactly on the activating touch's
// raw ACTION_UP point, clamped only to safe display bounds; touchless
// activations fall back to the Start button's center.
public final class MoaOrbPlacementTest {
    @Test
    public void centersOrbExactlyOnTouchPoint() {
        // Orb of 100px centered on x=500 → window left edge at 450.
        assertEquals(450, MoaOrbPlacement.topLeftForCenter(500f, 100, 0, 1080));
    }

    @Test
    public void roundsToNearestPixel() {
        // 100.6 - 50.5 = 50.1 → 50; 101.6 - 50.5 = 51.1 → 51.
        assertEquals(50, MoaOrbPlacement.topLeftForCenter(100.6f, 101, 0, 1080));
        assertEquals(51, MoaOrbPlacement.topLeftForCenter(101.6f, 101, 0, 1080));
    }

    @Test
    public void clampsToSafeMinimumEdge() {
        // Touch near the left/top edge: the orb stays fully inside the safe
        // bound instead of hanging off screen.
        assertEquals(16, MoaOrbPlacement.topLeftForCenter(5f, 100, 16, 1080));
        assertEquals(16, MoaOrbPlacement.topLeftForCenter(-40f, 100, 16, 1080));
    }

    @Test
    public void clampsToSafeMaximumEdge() {
        // Touch near the right/bottom edge: top-left is pulled back so
        // top-left + size stays within the safe maximum.
        assertEquals(964, MoaOrbPlacement.topLeftForCenter(1075f, 100, 16, 1064));
        assertEquals(964, MoaOrbPlacement.topLeftForCenter(2000f, 100, 16, 1064));
    }

    @Test
    public void unclampedInteriorPointIsUntouched() {
        assertEquals(490, MoaOrbPlacement.topLeftForCenter(540f, 100, 16, 1064));
    }

    @Test
    public void degenerateSafeRangePinsToSafeMinimum() {
        // Safe range smaller than the orb (foldable hinge case): pin to the
        // safe minimum rather than producing an inverted clamp.
        assertEquals(16, MoaOrbPlacement.topLeftForCenter(40f, 100, 16, 80));
    }

    @Test
    public void freshTouchDrivesPlacement() {
        assertTrue(MoaOrbPlacement.touchPlacementUsable(true, 10_000, 10_050));
        assertTrue(MoaOrbPlacement.touchPlacementUsable(true, 10_000, 10_000 + MoaOrbPlacement.TOUCH_FRESH_MS));
    }

    @Test
    public void staleTouchFallsBackToButtonCenter() {
        // A leftover ACTION_UP from an earlier cancelled press must not drive
        // an accessibility/keyboard click's placement.
        assertFalse(MoaOrbPlacement.touchPlacementUsable(
                true, 10_000, 10_001 + MoaOrbPlacement.TOUCH_FRESH_MS));
    }

    @Test
    public void touchlessActivationFallsBackToButtonCenter() {
        assertFalse(MoaOrbPlacement.touchPlacementUsable(false, 10_000, 10_050));
    }

    @Test
    public void clockSkewFallsBackToButtonCenter() {
        assertFalse(MoaOrbPlacement.touchPlacementUsable(true, 10_100, 10_050));
    }
}

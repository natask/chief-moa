package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaOrbOverlayGeometryTest {
    @Test
    public void surfaceStaysWhollyAboveWhenItFits() {
        MoaOrbOverlayGeometry.Position position = MoaOrbOverlayGeometry.anchoredSurface(
                1080, 1920, 10, 12,
                800, 900, 96,
                380, 430
        );

        assertEquals(900, position.orbY);
        assertEquals(458, position.y);
        assertTrue(position.y + 430 + 12 <= position.orbY);
    }

    @Test
    public void orbIsPushedDownSoTheSurfaceStaysAboveWhenItWouldNotFit() {
        MoaOrbOverlayGeometry.Position position = MoaOrbOverlayGeometry.anchoredSurface(
                1080, 1920, 10, 12,
                800, 430, 96,
                380, 430
        );

        // The orb yields down to the lowest position that fits card + gap above
        // it; the card is never placed below the orb.
        assertEquals(10 + 430 + 12, position.orbY);
        assertEquals(10, position.y);
        assertEquals(position.orbY, position.y + 430 + 12);
    }

    @Test
    public void growingSurfaceKeepsPushingTheOrbDownAsItRemeasures() {
        MoaOrbOverlayGeometry.Position small = MoaOrbOverlayGeometry.anchoredSurface(
                1080, 1920, 10, 12,
                800, 300, 96,
                380, 180
        );
        MoaOrbOverlayGeometry.Position grown = MoaOrbOverlayGeometry.anchoredSurface(
                1080, 1920, 10, 12,
                800, small.orbY, 96,
                380, 620
        );

        // The compact card fits above the orb at y=300, so the orb holds still;
        // only the grown remeasure forces it down.
        assertEquals(300, small.orbY);
        assertEquals(10 + 620 + 12, grown.orbY);
        assertTrue(grown.y + 620 + 12 <= grown.orbY);
    }

    @Test
    public void oversizedSurfaceNeverPushesTheOrbOffScreen() {
        MoaOrbOverlayGeometry.Position position = MoaOrbOverlayGeometry.anchoredSurface(
                1080, 1920, 10, 12,
                800, 400, 96,
                380, 1900
        );

        // Card taller than the space over the bottom-most orb: the orb wins the
        // bottom edge and the card clamps to the top margin, still above.
        assertEquals(1920 - 96 - 10, position.orbY);
        assertEquals(10, position.y);
        assertTrue(position.y < position.orbY);
    }

    @Test
    public void orbAlreadyLowEnoughIsNotMoved() {
        MoaOrbOverlayGeometry.Position position = MoaOrbOverlayGeometry.anchoredSurface(
                1080, 1920, 10, 12,
                800, 1700, 96,
                380, 430
        );

        assertEquals(1700, position.orbY);
        assertEquals(1700 - 430 - 12, position.y);
    }

    // 3x density: a 200x72dp target 34dp off the bottom, 12dp of tolerance.
    private static final int TARGET_W = 600;
    private static final int TARGET_H = 216;
    private static final int TARGET_INSET = 102;
    private static final int TOLERANCE = 36;
    private static final int ORB = 288;

    private static MoaOrbOverlayGeometry.Bounds target() {
        return MoaOrbOverlayGeometry.removeTargetBounds(1080, 2340, TARGET_W, TARGET_H, TARGET_INSET);
    }

    @Test
    public void removeTargetIsBottomCentred() {
        MoaOrbOverlayGeometry.Bounds bounds = target();

        assertEquals(240, bounds.left);
        assertEquals(840, bounds.right());
        assertEquals(2340 - TARGET_H - TARGET_INSET, bounds.top);
        assertEquals(2340 - TARGET_INSET, bounds.bottom());
    }

    @Test
    public void bottomRemoveHitUsesLatestOrbCenter() {
        MoaOrbOverlayGeometry.Bounds bounds = target();
        int onTargetY = bounds.top + TARGET_H / 2 - ORB / 2;

        assertTrue(MoaOrbOverlayGeometry.isInRemoveTarget(
                bounds, 540 - ORB / 2, onTargetY, ORB, TOLERANCE));
        assertFalse(MoaOrbOverlayGeometry.isInRemoveTarget(
                bounds, 0, onTargetY, ORB, TOLERANCE));
    }

    @Test
    public void theArmedZoneIsThePaintedRectanglePlusOneTolerance() {
        MoaOrbOverlayGeometry.Bounds bounds = target();
        int centreY = bounds.top + TARGET_H / 2;

        // Just outside the painted pill but inside the tolerance: armed.
        assertTrue(MoaOrbOverlayGeometry.isInRemoveTarget(
                bounds, bounds.right() + TOLERANCE - ORB / 2, centreY - ORB / 2, ORB, TOLERANCE));
        // One pixel past the tolerance: not armed.
        assertFalse(MoaOrbOverlayGeometry.isInRemoveTarget(
                bounds, bounds.right() + TOLERANCE + 1 - ORB / 2, centreY - ORB / 2, ORB, TOLERANCE));
    }

    @Test
    public void dragsThatMerelyPassNearTheBottomNoLongerArmRemoval() {
        MoaOrbOverlayGeometry.Bounds bounds = target();

        // The old rule armed on ANY orb centre within 170dp of the bottom and
        // 135dp of the horizontal middle — a zone several times the painted pill.
        // A drag along the bottom-left corner is now inert.
        assertFalse(MoaOrbOverlayGeometry.isInRemoveTarget(
                bounds, 0, 2340 - ORB, ORB, TOLERANCE));
        // So is one that stops well above the target.
        assertFalse(MoaOrbOverlayGeometry.isInRemoveTarget(
                bounds, 540 - ORB / 2, bounds.top - 400, ORB, TOLERANCE));
    }

    @Test
    public void aMissingTargetNeverArms() {
        assertFalse(MoaOrbOverlayGeometry.isInRemoveTarget(null, 540, 2000, ORB, TOLERANCE));
    }
}

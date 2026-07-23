package ai.moa.assistant;

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

    @Test
    public void bottomRemoveHitUsesLatestOrbCenter() {
        assertTrue(MoaOrbOverlayGeometry.isInRemoveTarget(
                1080, 1920, 492, 1702, 96, 170, 135));
        assertFalse(MoaOrbOverlayGeometry.isInRemoveTarget(
                1080, 1920, 100, 1702, 96, 170, 135));
    }
}

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

        assertTrue(position.aboveOrb);
        assertEquals(458, position.y);
        assertTrue(position.y + 430 + 12 <= 900);
    }

    @Test
    public void surfaceMovesBelowWheneverFullHeightDoesNotFitAbove() {
        MoaOrbOverlayGeometry.Position position = MoaOrbOverlayGeometry.anchoredSurface(
                1080, 1920, 10, 12,
                800, 430, 96,
                380, 430
        );

        assertFalse(position.aboveOrb);
        assertEquals(538, position.y);
        assertTrue(position.y >= 430 + 96 + 12);
    }

    @Test
    public void bottomRemoveHitUsesLatestOrbCenter() {
        assertTrue(MoaOrbOverlayGeometry.isInRemoveTarget(
                1080, 1920, 492, 1702, 96, 170, 135));
        assertFalse(MoaOrbOverlayGeometry.isInRemoveTarget(
                1080, 1920, 100, 1702, 96, 170, 135));
    }
}

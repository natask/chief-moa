package ai.moa.assistant;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class MoaOrbPresentationTest {
    @Test
    public void defaultMobileScaleShrinksTheNinetySixDpWindow() {
        assertEquals(67, MoaOrbPresentation.scaledWindowDp(MoaPrefs.ORB_SCALE_DEFAULT));
    }

    @Test
    public void configuredScaleIsAppliedAgainstTheStableBaseSize() {
        assertEquals(48, MoaOrbPresentation.scaledWindowDp(50));
        assertEquals(96, MoaOrbPresentation.scaledWindowDp(100));
        assertEquals(144, MoaOrbPresentation.scaledWindowDp(150));
    }

    @Test
    public void idleOrbRemainsVisibleAtThirtyPercentAlpha() {
        assertEquals(0.30f, MoaOrbPresentation.IDLE_ALPHA, 0.0001f);
    }

    @Test
    public void resizedWindowIsClampedInsideTheDisplay() {
        assertEquals(16, MoaOrbPresentation.clampWindowPosition(-20, 1080, 67, 16));
        assertEquals(997, MoaOrbPresentation.clampWindowPosition(1200, 1080, 67, 16));
        assertEquals(480, MoaOrbPresentation.clampWindowPosition(480, 1080, 67, 16));
    }

    @Test
    public void initialOrbXUsesTheRightEdgeWithoutDraftControlReservation() {
        assertEquals(997, MoaOrbWindowSizing.initialX(1080, 67, 16));
    }
}

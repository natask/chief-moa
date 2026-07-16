package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

// Native black surface invariants. The overlay's cards are opaque true-black
// family surfaces: no translucency (underlying app content must never bleed
// through) and no color cast (equal RGB channels), with elevation carried by
// hairline borders instead of glass.
public final class MoaColorsTest {
    private static int alpha(int color) {
        return (color >>> 24) & 0xFF;
    }

    private static boolean neutral(int color) {
        int r = (color >> 16) & 0xFF;
        int g = (color >> 8) & 0xFF;
        int b = color & 0xFF;
        return r == g && g == b;
    }

    @Test
    public void primarySurfacesAreOpaqueTrueBlack() {
        // Every card/surface background the spec claims as true black: the
        // full-app base + cards and the overlay panel/transcript cards.
        assertEquals(0xFF000000, MoaColors.SURFACE_0);
        assertEquals(0xFF000000, MoaColors.PANEL_BG);
        assertEquals(0xFF000000, MoaColors.APP_CARD_BG);
    }

    @Test
    public void raisedFillsAreOpaqueAndNeutral() {
        // Bubble/control fills sit one neutral step above the black cards:
        // opaque (no bleed-through) and cast-free, but intentionally not
        // #000000 so they stay distinguishable.
        assertEquals(0xFF, alpha(MoaColors.RAISED));
        assertEquals(0xFF, alpha(MoaColors.COMPOSER_BG));
        assertTrue("RAISED must be neutral (no color cast)", neutral(MoaColors.RAISED));
        assertTrue("COMPOSER_BG must be neutral (no color cast)", neutral(MoaColors.COMPOSER_BG));
    }

    @Test
    public void fadedFamilyAlphaIsDimButLegible() {
        assertTrue(MoaOverlayFadePolicy.FADED_ALPHA > 0.2f);
        assertTrue(MoaOverlayFadePolicy.FADED_ALPHA < 0.6f);
    }
}

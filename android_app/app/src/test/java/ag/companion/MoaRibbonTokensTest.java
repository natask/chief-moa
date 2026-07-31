package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Pure colour-policy tests for the ribbon tokens. No Android types are touched,
 * so the light/dark decision for the user's message plate is verified without
 * ever instantiating a view.
 */
public final class MoaRibbonTokensTest {

    /** Perceived luminance of the RGB channels, 0 (black) .. 255 (white). */
    private static double luminance(int argb) {
        int r = (argb >>> 16) & 0xFF;
        int g = (argb >>> 8) & 0xFF;
        int b = argb & 0xFF;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    @Test
    public void userPlateStaysNearBlackInBothSystemThemes() {
        assertTrue("dark theme user plate is near-black",
                luminance(MoaRibbonTokens.DARK.youPlate) < 60);
        assertTrue("light theme user plate is near-black too",
                luminance(MoaRibbonTokens.LIGHT.youPlate) < 60);
        assertTrue(luminance(MoaRibbonTokens.DARK.youPlateDrag) < 60);
        assertTrue(luminance(MoaRibbonTokens.LIGHT.youPlateDrag) < 60);
    }

    @Test
    public void userInkStaysLightForReadableContrastOnTheNearBlackPlate() {
        for (MoaRibbonTokens.Palette p :
                new MoaRibbonTokens.Palette[] {MoaRibbonTokens.DARK, MoaRibbonTokens.LIGHT}) {
            assertTrue("user ink is light", luminance(p.youInk) > 180);
            assertTrue("user ink reads against its plate",
                    luminance(p.youInk) - luminance(p.youPlate) > 150);
        }
    }

    @Test
    public void assistantPlateFollowsTheThemeSoTheTwoSpeakersStayDistinct() {
        // The reply plate is dark in dark mode and light in light mode; in light
        // mode that makes it plainly distinct from the near-black user plate.
        assertTrue(luminance(MoaRibbonTokens.DARK.plate) < 60);
        assertTrue(luminance(MoaRibbonTokens.LIGHT.plate) > 180);
        assertTrue("light-mode reply plate is far brighter than the user plate",
                luminance(MoaRibbonTokens.LIGHT.plate)
                        - luminance(MoaRibbonTokens.LIGHT.youPlate) > 150);
    }

    @Test
    public void assistantAccentRemainsDistinctFromTheUserPlate() {
        for (MoaRibbonTokens.Palette p :
                new MoaRibbonTokens.Palette[] {MoaRibbonTokens.DARK, MoaRibbonTokens.LIGHT}) {
            assertTrue("accent is not the user plate colour",
                    (p.accent & 0x00FFFFFF) != (p.youPlate & 0x00FFFFFF));
            assertTrue("accent is not the assistant plate colour",
                    (p.accent & 0x00FFFFFF) != (p.plate & 0x00FFFFFF));
        }
    }

    @Test
    public void plateColorRoutesUserAndAssistantSpeakers() {
        MoaRibbonTokens.Palette light = MoaRibbonTokens.LIGHT;
        assertEquals(light.youPlate, MoaRibbonTokens.plateColor(light, false, false));
        assertEquals(light.youPlateDrag, MoaRibbonTokens.plateColor(light, false, true));
        assertEquals(light.plate, MoaRibbonTokens.plateColor(light, true, false));
        assertEquals(light.plateDrag, MoaRibbonTokens.plateColor(light, true, true));

        MoaRibbonTokens.Palette dark = MoaRibbonTokens.DARK;
        assertEquals(dark.youPlate, MoaRibbonTokens.plateColor(dark, false, false));
        assertEquals(dark.plate, MoaRibbonTokens.plateColor(dark, true, false));
    }

    @Test
    public void inkColorRoutesUserAndAssistantSpeakers() {
        for (MoaRibbonTokens.Palette p :
                new MoaRibbonTokens.Palette[] {MoaRibbonTokens.DARK, MoaRibbonTokens.LIGHT}) {
            assertEquals(p.youInk, MoaRibbonTokens.inkColor(p, false));
            assertEquals(p.ink, MoaRibbonTokens.inkColor(p, true));
        }
    }
}

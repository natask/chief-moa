package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaComposerPanelMetricsTest {
    // A 1080px-wide phone at 3x.
    private static final int SCREEN_W = 1080;
    private static final float DENSITY = 3f;

    @Test
    public void aBubbleNeverSpansTheFullScreen() {
        int width = MoaComposerPanelMetrics.bubbleMaxTextWidth(SCREEN_W, DENSITY);

        assertTrue("width=" + width, width < SCREEN_W);
        // 80% of the screen, less the bubble's own padding and its far gutter.
        assertEquals((int) (SCREEN_W * 0.80f)
                - Math.round(28 * DENSITY) - Math.round(36 * DENSITY), width);
    }

    @Test
    public void aNarrowScreenNarrowsTheBubbleRatherThanCollapsingIt() {
        // A negative maxWidth would collapse the TextView to nothing instead of
        // simply making it narrow, so the floor is load-bearing.
        assertEquals(0, MoaComposerPanelMetrics.bubbleMaxTextWidth(100, DENSITY));
        assertEquals(0, MoaComposerPanelMetrics.bubbleMaxTextWidth(0, DENSITY));
    }

    @Test
    public void theArithmeticMatchesTheInlineVersionItReplaced() {
        // Guards the refactor itself. A rounded fraction or a single 64dp
        // conversion would drift by a pixel at some width/density pairs.
        for (float density : new float[]{1f, 1.5f, 2f, 2.625f, 2.75f, 3f, 3.5f, 4f}) {
            for (int screen : new int[]{720, 1077, 1079, 1080, 1440, 2160}) {
                int expected = (int) (screen * 0.80f)
                        - Math.round(28 * density) - Math.round(36 * density);
                assertEquals("density=" + density + " screen=" + screen,
                        Math.max(0, expected),
                        MoaComposerPanelMetrics.bubbleMaxTextWidth(screen, density));
            }
        }
    }

    @Test
    public void thePanelWidthMatchesTheInlineVersionItReplaced() {
        for (float density : new float[]{1f, 2.625f, 3f, 3.5f}) {
            for (int screen : new int[]{720, 1080, 1440, 2160}) {
                int expected = Math.min(
                        screen - Math.round(20 * density), Math.round(380 * density));
                assertEquals("density=" + density + " screen=" + screen,
                        Math.max(0, expected),
                        MoaComposerPanelMetrics.panelWidth(screen, density));
            }
        }
    }

    @Test
    public void theBubbleWidthGrowsWithTheScreen() {
        int small = MoaComposerPanelMetrics.bubbleMaxTextWidth(720, DENSITY);
        int large = MoaComposerPanelMetrics.bubbleMaxTextWidth(1440, DENSITY);

        assertTrue(large > small);
    }

    @Test
    public void thePanelIsCappedOnAWideScreen() {
        // A tablet must not get a 1600px-wide chat panel.
        assertEquals(Math.round(380 * DENSITY),
                MoaComposerPanelMetrics.panelWidth(2000, DENSITY));
    }

    @Test
    public void thePanelInsetsFromBothEdgesOnANarrowScreen() {
        int narrow = 600;
        assertEquals(narrow - Math.round(20 * DENSITY),
                MoaComposerPanelMetrics.panelWidth(narrow, DENSITY));
    }

    @Test
    public void thePanelWidthIsNeverNegative() {
        assertEquals(0, MoaComposerPanelMetrics.panelWidth(0, DENSITY));
        assertEquals(0, MoaComposerPanelMetrics.panelWidth(10, DENSITY));
    }

    @Test
    public void aBubbleFitsInsideItsPanelAtEveryPhoneWidth() {
        for (int screen : new int[]{720, 1080, 1440}) {
            int panel = MoaComposerPanelMetrics.panelWidth(screen, DENSITY);
            int bubble = MoaComposerPanelMetrics.bubbleMaxTextWidth(screen, DENSITY);
            assertTrue("screen=" + screen + " panel=" + panel + " bubble=" + bubble,
                    bubble <= panel);
        }
    }

    @Test
    public void theBubbleCapStopsBitingOnATabletSizedScreen() {
        // Pinning existing behaviour, not endorsing it. The bubble cap is a
        // fraction of the SCREEN while the panel is capped in dp, so past roughly
        // 1780px at 3x the cap exceeds the panel and stops constraining anything:
        // the layout clamps the bubble to the panel and it spans edge to edge,
        // losing the ~80% inset the cap exists to create.
        //
        // Harmless on every phone this ships to, and changing it here would be a
        // behaviour change inside a refactor. Left for a deliberate fix.
        int panel = MoaComposerPanelMetrics.panelWidth(2000, DENSITY);
        int bubble = MoaComposerPanelMetrics.bubbleMaxTextWidth(2000, DENSITY);

        assertTrue("bubble=" + bubble + " panel=" + panel, bubble > panel);
    }
}

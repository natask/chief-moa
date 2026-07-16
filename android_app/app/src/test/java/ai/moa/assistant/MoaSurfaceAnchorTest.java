package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

// Anchoring math for surfaces hanging off the lion orb. The regression these
// tests pin: when the orb is repositioned (drag or start-under-finger), an
// already-open panel/transcript follows it through this same math instead of
// staying stranded or being closed.
public final class MoaSurfaceAnchorTest {
    private static final int SCREEN_W = 1080;
    private static final int SCREEN_H = 2280;
    private static final int ORB = 120;
    private static final int MARGIN = 10;
    private static final int GAP = 12;

    @Test
    public void surfaceCentersHorizontallyOnOrb() {
        // Orb at x=400 → orb center 460 → surface (width 380) left at 270.
        assertEquals(270, MoaSurfaceAnchor.anchoredX(400, ORB, 380, SCREEN_W, MARGIN));
    }

    @Test
    public void openSurfaceFollowsRepositionedOrb() {
        // The start-under-finger regression: an open panel anchored to the orb
        // must land on the new center after the orb is repositioned.
        int before = MoaSurfaceAnchor.anchoredX(400, ORB, 380, SCREEN_W, MARGIN);
        int after = MoaSurfaceAnchor.anchoredX(500, ORB, 380, SCREEN_W, MARGIN);
        assertEquals(before + 100, after);

        int beforeY = MoaSurfaceAnchor.anchoredY(1500, ORB, 430, SCREEN_H, MARGIN, GAP);
        int afterY = MoaSurfaceAnchor.anchoredY(1700, ORB, 430, SCREEN_H, MARGIN, GAP);
        assertEquals(beforeY + 200, afterY);
    }

    @Test
    public void horizontalClampAtScreenEdges() {
        // Orb hugging the left edge: surface pins to the margin.
        assertEquals(MARGIN, MoaSurfaceAnchor.anchoredX(0, ORB, 380, SCREEN_W, MARGIN));
        // Orb hugging the right edge: surface pins to screen - width - margin.
        assertEquals(SCREEN_W - 380 - MARGIN,
                MoaSurfaceAnchor.anchoredX(SCREEN_W - ORB, ORB, 380, SCREEN_W, MARGIN));
    }

    @Test
    public void surfaceWiderThanScreenHugsRawEdges() {
        assertEquals(0, MoaSurfaceAnchor.anchoredX(400, ORB, SCREEN_W + 40, SCREEN_W, MARGIN));
    }

    @Test
    public void placesAboveOrbWhenItFits() {
        // Orb low on screen: surface (height 430) sits above with the gap.
        assertEquals(1500 - 430 - GAP,
                MoaSurfaceAnchor.anchoredY(1500, ORB, 430, SCREEN_H, MARGIN, GAP));
    }

    @Test
    public void fallsBelowOrbWhenNoRoomAbove() {
        // Orb near the top: below has more room, surface sits under the orb.
        assertEquals(100 + ORB + GAP,
                MoaSurfaceAnchor.anchoredY(100, ORB, 430, SCREEN_H, MARGIN, GAP));
    }

    @Test
    public void verticalClampKeepsSurfaceOnScreen() {
        // Orb near the top forces a tall surface below, where it cannot fully
        // fit: the bottom clamp pulls it back inside the margin.
        assertEquals(SCREEN_H - 2000 - MARGIN,
                MoaSurfaceAnchor.anchoredY(200, ORB, 2000, SCREEN_H, MARGIN, GAP));
    }
}

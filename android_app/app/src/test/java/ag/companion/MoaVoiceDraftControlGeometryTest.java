package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaVoiceDraftControlGeometryTest {
    @Test
    public void cancelIsLeftAndPauseIsRightAtOrbCenter() {
        MoaVoiceDraftControlGeometry.Slots slots =
                MoaVoiceDraftControlGeometry.slots(400, 600, 500, 700,
                        1080, 1920, 144, 72, 12);
        assertEquals(244, slots.cancel.left);
        assertEquals(602, slots.cancel.top);
        assertEquals(388, slots.cancel.right);
        assertEquals(512, slots.pause.left);
        assertEquals(602, slots.pause.top);
        assertEquals(656, slots.pause.right);
        assertEquals(96, slots.cancel.bottom - slots.cancel.top);
        assertTrue(slots.cancel.right < 400);
        assertTrue(slots.pause.left > 500);
    }

    @Test
    public void leftEdgeMovesBothControlsRightWithoutTouchingOrb() {
        MoaVoiceDraftControlGeometry.Slots left = MoaVoiceDraftControlGeometry.slots(
                0, 0, 80, 80, 320, 480, 100, 60, 8);
        assertEquals(196, left.cancel.left);
        assertEquals(88, left.pause.left);
        assertEquals(7, left.cancel.top);
        assertGapAndScreenBounds(left, 0, 0, 80, 80, 320, 480, 8);
    }

    @Test
    public void rightEdgeMovesBothControlsLeftWithoutTouchingOrb() {
        MoaVoiceDraftControlGeometry.Slots right = MoaVoiceDraftControlGeometry.slots(
                280, 440, 320, 480, 320, 480, 100, 60, 8);
        assertEquals(172, right.cancel.left);
        assertEquals(64, right.pause.left);
        assertEquals(413, right.pause.top);
        assertGapAndScreenBounds(right, 280, 440, 320, 480, 320, 480, 8);
    }

    @Test
    public void narrowPortraitFallsBackAboveAndBelowOrb() {
        MoaVoiceDraftControlGeometry.Slots slots = MoaVoiceDraftControlGeometry.slots(
                50, 200, 130, 280, 180, 640, 72, 36, 8);
        assertEquals(144, slots.cancel.top);
        assertEquals(288, slots.pause.top);
        assertGapAndScreenBounds(slots, 50, 200, 130, 280, 180, 640, 8);
    }

    @Test
    public void narrowLandscapeCornerStacksBelowOrb() {
        MoaVoiceDraftControlGeometry.Slots slots = MoaVoiceDraftControlGeometry.slots(
                50, 0, 130, 64, 180, 240, 72, 36, 8);
        assertEquals(72, slots.cancel.top);
        assertEquals(128, slots.pause.top);
        assertGapAndScreenBounds(slots, 50, 0, 130, 64, 180, 240, 8);
    }

    @Test
    public void impossibleScreenReturnsBoundedFallbackInsteadOfThrowing() {
        MoaVoiceDraftControlGeometry.Slots slots = MoaVoiceDraftControlGeometry.slots(
                0, 0, 2, 2, 2, 2, Integer.MAX_VALUE, Integer.MAX_VALUE,
                Integer.MAX_VALUE);
        assertEquals(0, slots.cancel.left);
        assertEquals(0, slots.cancel.top);
        assertEquals(1, slots.cancel.right);
        assertEquals(1, slots.cancel.bottom);
        assertEquals(1, slots.pause.left);
        assertEquals(1, slots.pause.top);
        assertEquals(2, slots.pause.right);
        assertEquals(2, slots.pause.bottom);
        assertInside(slots.cancel, 2, 2);
        assertInside(slots.pause, 2, 2);
        assertSeparated(slots.cancel, slots.pause, 0);
    }

    private static void assertGapAndScreenBounds(MoaVoiceDraftControlGeometry.Slots slots,
            int orbLeft, int orbTop, int orbRight, int orbBottom,
            int screenWidth, int screenHeight, int gap) {
        MoaVoiceDraftControlGeometry.Bounds orb =
                new MoaVoiceDraftControlGeometry.Bounds(orbLeft, orbTop, orbRight, orbBottom);
        assertInside(slots.cancel, screenWidth, screenHeight);
        assertInside(slots.pause, screenWidth, screenHeight);
        assertSeparated(slots.cancel, orb, gap);
        assertSeparated(slots.pause, orb, gap);
        assertSeparated(slots.cancel, slots.pause, gap);
    }

    private static void assertInside(MoaVoiceDraftControlGeometry.Bounds bounds,
            int screenWidth, int screenHeight) {
        assertTrue(bounds.left >= 0);
        assertTrue(bounds.top >= 0);
        assertTrue(bounds.right <= screenWidth);
        assertTrue(bounds.bottom <= screenHeight);
    }

    private static void assertSeparated(MoaVoiceDraftControlGeometry.Bounds first,
            MoaVoiceDraftControlGeometry.Bounds second, int gap) {
        assertTrue(first.right + gap <= second.left
                || second.right + gap <= first.left
                || first.bottom + gap <= second.top
                || second.bottom + gap <= first.top);
    }
}

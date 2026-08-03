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
        assertEquals(614, slots.cancel.top);
        assertEquals(388, slots.cancel.right);
        assertEquals(512, slots.pause.left);
        assertEquals(614, slots.pause.top);
        assertEquals(656, slots.pause.right);
        assertTrue(slots.cancel.right < 400);
        assertTrue(slots.pause.left > 500);
    }

    @Test
    public void sideControlsStayInsideScreenBounds() {
        MoaVoiceDraftControlGeometry.Slots left = MoaVoiceDraftControlGeometry.slots(
                0, 0, 80, 80, 320, 480, 100, 60, 8);
        assertEquals(0, left.cancel.left);
        assertEquals(88, left.pause.left);
        assertEquals(10, left.cancel.top);

        MoaVoiceDraftControlGeometry.Slots right = MoaVoiceDraftControlGeometry.slots(
                280, 440, 320, 480, 320, 480, 100, 60, 8);
        assertEquals(172, right.cancel.left);
        assertEquals(220, right.pause.left);
        assertEquals(420, right.pause.top);
    }
}

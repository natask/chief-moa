package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import android.view.WindowManager;

import java.util.List;

public final class MoaMinimalRingGeometryTest {
    @Test
    public void portraitEdgesRespectInsetsAndLeaveCenterAndCornersEmpty() {
        List<MoaMinimalRingGeometry.Bounds> edges = MoaMinimalRingGeometry.edges(
                1080, 2400, 0, 96, 0, 120, 8, 24);

        assertEquals(4, edges.size());
        assertBounds(edges.get(0), 24, 96, 1056, 104);
        assertBounds(edges.get(1), 1072, 120, 1080, 2256);
        assertBounds(edges.get(2), 24, 2272, 1056, 2280);
        assertBounds(edges.get(3), 0, 120, 8, 2256);
        assertFalse(MoaMinimalRingGeometry.covered(edges, 540, 1200));
        assertFalse(MoaMinimalRingGeometry.covered(edges, 4, 100));
        assertTrue(MoaMinimalRingGeometry.covered(edges, 540, 100));
    }

    @Test
    public void landscapeEdgesStayInsideAsymmetricCutoutInsets() {
        List<MoaMinimalRingGeometry.Bounds> edges = MoaMinimalRingGeometry.edges(
                2400, 1080, 88, 0, 44, 48, 6, 18);

        for (MoaMinimalRingGeometry.Bounds edge : edges) {
            assertTrue(edge.left >= 88);
            assertTrue(edge.top >= 0);
            assertTrue(edge.right <= 2356);
            assertTrue(edge.bottom <= 1032);
            assertTrue(edge.width() > 0);
            assertTrue(edge.height() > 0);
        }
        assertFalse(MoaMinimalRingGeometry.covered(edges, 1200, 540));
    }

    @Test
    public void everyMinimalEdgeWindowIsNonTouchable() {
        assertTrue((MoaMinimalRingController.windowFlags()
                & WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE) != 0);
    }

    @Test
    public void fallbackButtonAloneRetainsTouchAuthority() {
        assertEquals(0, MoaMinimalRingController.fallbackWindowFlags()
                & WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
    }

    @Test
    public void fallbackButtonStaysInsideSafeLandscapeFrame() {
        MoaMinimalRingGeometry.Bounds fallback = MoaMinimalRingGeometry.fallback(
                2400, 1080, 88, 0, 44, 48, 88, 24);
        assertBounds(fallback, 1156, 920, 1244, 1008);
    }

    private static void assertBounds(MoaMinimalRingGeometry.Bounds actual,
            int left, int top, int right, int bottom) {
        assertEquals(left, actual.left);
        assertEquals(top, actual.top);
        assertEquals(right, actual.right);
        assertEquals(bottom, actual.bottom);
    }
}

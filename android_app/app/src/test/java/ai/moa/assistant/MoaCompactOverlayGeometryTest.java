package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public final class MoaCompactOverlayGeometryTest {
    @Test
    public void unionContainsOnlyCompactMovingUnit() {
        MoaCompactOverlayGeometry.Bounds union = MoaCompactOverlayGeometry.union(Arrays.asList(
                bounds(120, 220, 200, 300),
                bounds(40, 180, 280, 220),
                bounds(40, 300, 280, 340)));
        assertBounds(union, 40, 180, 280, 340);
    }

    @Test
    public void screenBoundsRebaseWithoutChangingSize() {
        MoaCompactOverlayGeometry.Bounds local = MoaCompactOverlayGeometry.relative(
                bounds(120, 220, 200, 300), bounds(40, 180, 280, 340));
        assertBounds(local, 80, 40, 160, 120);
    }

    @Test
    public void emptyInputProducesNoPhantomTouchSurface() {
        assertTrue(MoaCompactOverlayGeometry.union(Collections.emptyList()).empty());
    }

    private static MoaCompactOverlayGeometry.Bounds bounds(int l, int t, int r, int b) {
        return new MoaCompactOverlayGeometry.Bounds(l, t, r, b);
    }

    private static void assertBounds(
            MoaCompactOverlayGeometry.Bounds actual, int l, int t, int r, int b) {
        assertEquals(l, actual.left);
        assertEquals(t, actual.top);
        assertEquals(r, actual.right);
        assertEquals(b, actual.bottom);
    }
}

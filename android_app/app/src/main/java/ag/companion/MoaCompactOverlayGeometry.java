package ag.companion;

import java.util.List;

/** Pure geometry for the one-window compact overlay. */
final class MoaCompactOverlayGeometry {
    private MoaCompactOverlayGeometry() {}

    static final class Bounds {
        final int left;
        final int top;
        final int right;
        final int bottom;

        Bounds(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        int width() { return Math.max(0, right - left); }
        int height() { return Math.max(0, bottom - top); }
        boolean empty() { return width() == 0 || height() == 0; }
    }

    static Bounds union(List<Bounds> rectangles) {
        int left = 0, top = 0, right = 0, bottom = 0;
        boolean initialized = false;
        for (Bounds rectangle : rectangles) {
            if (rectangle == null || rectangle.empty()) continue;
            if (!initialized) {
                left = rectangle.left;
                top = rectangle.top;
                right = rectangle.right;
                bottom = rectangle.bottom;
                initialized = true;
            } else {
                left = Math.min(left, rectangle.left);
                top = Math.min(top, rectangle.top);
                right = Math.max(right, rectangle.right);
                bottom = Math.max(bottom, rectangle.bottom);
            }
        }
        return new Bounds(left, top, right, bottom);
    }

    static Bounds relative(Bounds screenRect, Bounds windowBounds) {
        return new Bounds(
                screenRect.left - windowBounds.left,
                screenRect.top - windowBounds.top,
                screenRect.right - windowBounds.left,
                screenRect.bottom - windowBounds.top);
    }
}

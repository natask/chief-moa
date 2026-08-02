package ag.companion;

import java.util.Arrays;
import java.util.List;

/** Pure geometry for the four independent, non-touchable Minimal edge windows. */
final class MoaMinimalRingGeometry {
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

        int width() { return right - left; }
        int height() { return bottom - top; }
        boolean contains(int x, int y) {
            return x >= left && x < right && y >= top && y < bottom;
        }
    }

    private MoaMinimalRingGeometry() {}

    static List<Bounds> edges(int width, int height, int insetLeft, int insetTop,
            int insetRight, int insetBottom, int thickness, int cornerGap) {
        int left = clamp(insetLeft, 0, width);
        int top = clamp(insetTop, 0, height);
        int right = clamp(width - Math.max(0, insetRight), left, width);
        int bottom = clamp(height - Math.max(0, insetBottom), top, height);
        int t = Math.max(1, Math.min(Math.max(1, thickness),
                Math.max(1, Math.min(right - left, bottom - top) / 2)));
        int gap = Math.max(0, cornerGap);
        int horizontalLeft = Math.min(right, left + gap);
        int horizontalRight = Math.max(horizontalLeft, right - gap);
        int verticalTop = Math.min(bottom, top + gap);
        int verticalBottom = Math.max(verticalTop, bottom - gap);
        return Arrays.asList(
                new Bounds(horizontalLeft, top, horizontalRight, Math.min(bottom, top + t)),
                new Bounds(Math.max(left, right - t), verticalTop, right, verticalBottom),
                new Bounds(horizontalLeft, Math.max(top, bottom - t), horizontalRight, bottom),
                new Bounds(left, verticalTop, Math.min(right, left + t), verticalBottom));
    }

    static boolean covered(List<Bounds> windows, int x, int y) {
        for (Bounds window : windows) if (window.contains(x, y)) return true;
        return false;
    }

    static Bounds fallback(int width, int height, int insetLeft, int insetTop,
            int insetRight, int insetBottom, int size, int gap) {
        int left = clamp(insetLeft, 0, width);
        int top = clamp(insetTop, 0, height);
        int right = clamp(width - Math.max(0, insetRight), left, width);
        int bottom = clamp(height - Math.max(0, insetBottom), top, height);
        int boundedSize = Math.max(1, Math.min(size, Math.min(right - left, bottom - top)));
        int x = clamp((width - boundedSize) / 2, left, Math.max(left, right - boundedSize));
        int y = clamp(bottom - boundedSize - Math.max(0, gap), top,
                Math.max(top, bottom - boundedSize));
        return new Bounds(x, y, x + boundedSize, y + boundedSize);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}

package ag.companion;

/** Keeps draft controls on-screen and outside the orb and transcript ribbon lanes. */
final class MoaVoiceDraftControlGeometry {
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
    }

    static final class Slots {
        final Bounds cancel;
        final Bounds pause;

        Slots(Bounds cancel, Bounds pause) {
            this.cancel = cancel;
            this.pause = pause;
        }
    }

    private MoaVoiceDraftControlGeometry() {
    }

    static Slots slots(int orbLeft, int orbTop, int orbRight, int orbBottom,
            int screenWidth, int screenHeight,
            int controlWidth, int controlHeight, int gap) {
        int safeScreenWidth = Math.max(1, screenWidth);
        int safeScreenHeight = Math.max(1, screenHeight);
        int safeGap = Math.max(0, gap);
        int width = Math.min(safeScreenWidth, Math.max(1, controlWidth));
        // The production control is 72dp wide. Its bounded overlay window is also
        // its touch target, so keep that window at least 48dp tall when callers
        // request only the smaller visual-pill height.
        int minimumTouchHeight = (int) Math.min(Integer.MAX_VALUE,
                ((long) width * 2L + 2L) / 3L);
        int height = Math.min(safeScreenHeight,
                Math.max(Math.max(1, controlHeight), minimumTouchHeight));

        Slots result = findLayout(orbLeft, orbTop, orbRight, orbBottom,
                safeScreenWidth, safeScreenHeight, width, height, safeGap);
        if (result != null) return result;

        int degradedWidth = width;
        int degradedHeight = height;
        while (degradedWidth > 1 || degradedHeight > 1) {
            degradedWidth = Math.max(1, degradedWidth / 2);
            degradedHeight = Math.max(1, degradedHeight / 2);
            result = findLayout(orbLeft, orbTop, orbRight, orbBottom,
                    safeScreenWidth, safeScreenHeight,
                    degradedWidth, degradedHeight, safeGap);
            if (result != null) return result;
        }
        if (safeGap > 0) {
            result = findLayout(orbLeft, orbTop, orbRight, orbBottom,
                    safeScreenWidth, safeScreenHeight, 1, 1, 0);
            if (result != null) return result;
        }

        // The orb consumes every available pixel. Keep both fallback windows
        // bounded and as small as possible; overlap is physically unavoidable.
        return new Slots(
                new Bounds(0, 0, 1, 1),
                new Bounds(safeScreenWidth - 1, safeScreenHeight - 1,
                        safeScreenWidth, safeScreenHeight));
    }

    private static Slots findLayout(int orbLeft, int orbTop, int orbRight, int orbBottom,
            int screenWidth, int screenHeight, int width, int height, int gap) {
        int orbCenterY = midpoint(orbTop, orbBottom);
        int orbCenterX = midpoint(orbLeft, orbRight);
        int centeredTop = clamp(safeSubtract(orbCenterY, height / 2),
                0, screenHeight - height);
        int centeredLeft = clamp(safeSubtract(orbCenterX, width / 2),
                0, screenWidth - width);

        Bounds leftNear = bounds(safeSubtract(orbLeft, gap, width),
                centeredTop, width, height);
        Bounds leftFar = bounds(safeSubtract(leftNear.left, gap, width),
                centeredTop, width, height);
        Bounds rightNear = bounds(safeAdd(orbRight, gap), centeredTop, width, height);
        Bounds rightFar = bounds(safeAdd(rightNear.right, gap), centeredTop, width, height);
        Bounds aboveNear = bounds(centeredLeft, safeSubtract(orbTop, gap, height),
                width, height);
        Bounds aboveFar = bounds(centeredLeft, safeSubtract(aboveNear.top, gap, height),
                width, height);
        Bounds belowNear = bounds(centeredLeft, safeAdd(orbBottom, gap), width, height);
        Bounds belowFar = bounds(centeredLeft, safeAdd(belowNear.bottom, gap), width, height);

        Bounds orb = new Bounds(orbLeft, orbTop, orbRight, orbBottom);
        Bounds[][] layouts = {
                {leftNear, rightNear},
                {rightFar, rightNear},
                {leftNear, leftFar},
                {aboveNear, belowNear},
                {belowNear, belowFar},
                {aboveNear, aboveFar}
        };
        for (Bounds[] layout : layouts) {
            if (validLayout(layout[0], layout[1], orb, gap, screenWidth, screenHeight)) {
                return new Slots(layout[0], layout[1]);
            }
        }
        return null;
    }

    private static Bounds bounds(int left, int top, int width, int height) {
        return new Bounds(left, top, safeAdd(left, width), safeAdd(top, height));
    }

    private static boolean fits(Bounds bounds, int screenWidth, int screenHeight) {
        return bounds.left >= 0 && bounds.top >= 0
                && bounds.right <= screenWidth && bounds.bottom <= screenHeight;
    }

    private static boolean validLayout(Bounds cancel, Bounds pause, Bounds orb,
            int gap, int screenWidth, int screenHeight) {
        return fits(cancel, screenWidth, screenHeight)
                && fits(pause, screenWidth, screenHeight)
                && separated(cancel, orb, gap)
                && separated(pause, orb, gap)
                && separated(cancel, pause, gap);
    }

    private static boolean separated(Bounds first, Bounds second, int gap) {
        return (long) first.right + gap <= second.left
                || (long) second.right + gap <= first.left
                || (long) first.bottom + gap <= second.top
                || (long) second.bottom + gap <= first.top;
    }

    private static int midpoint(int first, int second) {
        return (int) (((long) first + second) / 2L);
    }

    private static int safeAdd(int first, int second) {
        long result = (long) first + second;
        return (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, result));
    }

    private static int safeSubtract(int first, int... values) {
        long result = first;
        for (int value : values) result -= value;
        return (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, result));
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
}

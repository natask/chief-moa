package ag.companion;

/** Keeps draft controls beside the orb and out of the transcript ribbon lanes. */
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
        int width = Math.max(1, controlWidth);
        int height = Math.max(1, controlHeight);
        int maxLeft = Math.max(0, screenWidth - width);
        int orbCenterY = orbTop + (orbBottom - orbTop) / 2;
        int top = clamp(orbCenterY - height / 2, 0, Math.max(0, screenHeight - height));
        int cancelLeft = clamp(orbLeft - gap - width, 0, maxLeft);
        int pauseLeft = clamp(orbRight + gap, 0, maxLeft);
        return new Slots(
                new Bounds(cancelLeft, top, cancelLeft + width, top + height),
                new Bounds(pauseLeft, top, pauseLeft + width, top + height));
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
}

package ag.companion;

/** Pure presentation constants shared by the orb window and touch behavior. */
final class MoaOrbPresentation {
    static final int BASE_WINDOW_DP = 96;
    static final float IDLE_ALPHA = 0.30f;

    private MoaOrbPresentation() {
    }

    static int scaledWindowDp(int scalePercent) {
        return Math.max(1, Math.round(BASE_WINDOW_DP * scalePercent / 100f));
    }

    static int clampWindowPosition(int position, int displayExtent, int windowSize, int margin) {
        return Math.max(margin, Math.min(position, Math.max(margin, displayExtent - windowSize - margin)));
    }
}

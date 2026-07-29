package ag.companion;

/**
 * The composer panel's size arithmetic, pulled out of the view builders so the
 * bounds can be checked without inflating anything.
 */
final class MoaComposerPanelMetrics {
    /** Fraction of the screen a chat bubble's text may occupy. */
    static final float BUBBLE_WIDTH_FRACTION = 0.80f;
    /** Bubble padding, in dp, that sits inside the fraction. */
    static final int BUBBLE_PADDING_DP = 28;
    /** Gutter, in dp, that keeps the far edge of a bubble off the panel wall. */
    static final int BUBBLE_GUTTER_DP = 36;
    /** Panel width cap and the screen inset it leaves, both in dp. */
    static final int PANEL_MAX_W_DP = 380;
    static final int PANEL_SCREEN_INSET_DP = 20;

    private MoaComposerPanelMetrics() {
    }

    /**
     * The widest a bubble's text may be. Never negative: a very narrow screen
     * would otherwise hand TextView a negative maxWidth and collapse the bubble
     * to nothing rather than simply making it narrow.
     */
    static int bubbleMaxTextWidth(int screenWidthPx, float density) {
        // Truncating cast and two separately rounded dp conversions, exactly as
        // the inline version did: rounding the fraction, or converting 64dp in
        // one step, both shift the result by a pixel at some widths and
        // densities. This is a refactor, so it stays bit-for-bit.
        int fraction = (int) (screenWidthPx * BUBBLE_WIDTH_FRACTION);
        int chrome = Math.round(BUBBLE_PADDING_DP * density)
                + Math.round(BUBBLE_GUTTER_DP * density);
        return Math.max(0, fraction - chrome);
    }

    /** Panel window width: capped, and inset from both screen edges. */
    static int panelWidth(int screenWidthPx, float density) {
        int inset = screenWidthPx - Math.round(PANEL_SCREEN_INSET_DP * density);
        return Math.max(0, Math.min(inset, Math.round(PANEL_MAX_W_DP * density)));
    }
}

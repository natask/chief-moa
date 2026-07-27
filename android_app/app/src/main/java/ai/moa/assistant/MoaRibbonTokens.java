package ai.moa.assistant;

/**
 * Design tokens for the companion + ribbons overlay unit.
 *
 * Mirrors the CSS custom properties the browser extension ships for the same
 * contract (reference/design/overlay-2026-07/spec.md §8-§9). Values are kept as
 * plain constants with no Android types so the numbers stay unit testable and so
 * a drift between the two surfaces is a one-file diff.
 *
 * Colours are 0xAARRGGBB. Two palettes exist because the ambient state paints no
 * plate: the glyphs sit on whatever app is behind the overlay, so a dark-on-dark
 * or light-on-light pairing has to be selectable.
 */
final class MoaRibbonTokens {
    private MoaRibbonTokens() {
    }

    // --- Sliding window ---------------------------------------------------
    /** Hard cap on rendered grapheme clusters. A safety bound, not the visual window. */
    static final int WINDOW_CHARS = 140;
    /** Per-turn retained text. Copy reads this; the window is a tail of it. */
    static final int BUFFER_MAX_CHARS = 8000;

    // --- Motion (ms) ------------------------------------------------------
    static final long DUR_FAST_MS = 120;
    static final long DUR_SOLIDIFY_MS = 140;
    static final long DUR_SOFTEN_MS = 260;
    static final long DUR_SLOW_MS = 420;
    static final long DUR_SLIDE_MS = 90;
    static final long DUR_SETTLE_MS = 320;
    static final long DUR_MENU_MS = 160;
    static final long DUR_LATCH_MS = 6000;
    static final long LINGER_YOU_MS = 4500;
    static final long LINGER_REPLY_MS = 9000;
    /** Unspoken or failed replies have to be read, so they linger longer. */
    static final long LINGER_UNREAD_MS = 14000;
    static final long CARET_BLINK_MS = 1060;

    // --- Gestures ---------------------------------------------------------
    static final long HOLD_MS = 340;
    static final long MULTITAP_MS = 260;
    static final long FLASH_MS = 180;
    static final long MENU_IDLE_DISMISS_MS = 5000;

    // --- Geometry (dp) ----------------------------------------------------
    static final int RIBBON_H_DP = 28;
    /** The single step the ribbon may grow by at very large system font scales. */
    static final int RIBBON_H_LARGE_DP = 32;
    static final float FONT_SCALE_CLAMP = 1.3f;
    static final int RIBBON_MAX_W_DP = 340;
    static final int RIBBON_PAD_X_DP = 10;
    static final int GAP_DP = 8;
    static final int DOT_SIZE_DP = 5;
    static final int DOT_OFFSET_DP = 10;
    static final int EDGE_MARGIN_DP = 16;
    static final int FADE_W_DP = 16;
    static final int RAIL_GLYPH_DP = 20;
    static final int RAIL_HIT_W_DP = 32;
    static final int MENU_W_DP = 176;
    static final int MENU_ROW_H_DP = 36;
    static final int RADIUS_RIBBON_DP = 9;
    static final int RADIUS_SCRIM_DP = 4;
    static final int RADIUS_MENU_DP = 12;
    static final int HAIRLINE_DP = 1;
    static final int CARET_W_DP = 2;
    static final int CARET_H_DP = 14;
    /** Inflation applied to the painted glyph run when hit-testing a ribbon. */
    static final int HIT_INFLATE_DP = 8;
    static final int TEXT_SP = 13;
    static final int MENU_TEXT_SP = 13;

    // --- Companion opacity ------------------------------------------------
    static final float COMPANION_DORMANT_ALPHA = 0.18f;
    static final float COMPANION_AMBIENT_ALPHA = 0.92f;
    static final float COMPANION_ENGAGED_ALPHA = 1f;
    static final float COMPANION_DRAG_SCALE = 1.04f;

    /** One themed colour set. Android picks by Configuration.uiMode only. */
    static final class Palette {
        final int ink;
        final int inkAmbient;
        final int muted;
        final int accent;
        final int you;
        final int agent;
        final int ok;
        final int warn;
        final int plate;
        final int plateDrag;
        final int hairline;
        final int scrim;
        final int halo;
        final int menuBg;
        final int menuRowPressed;

        private Palette(int ink, int inkAmbient, int muted, int accent, int you, int agent,
                        int ok, int warn, int plate, int plateDrag, int hairline, int scrim,
                        int halo, int menuBg, int menuRowPressed) {
            this.ink = ink;
            this.inkAmbient = inkAmbient;
            this.muted = muted;
            this.accent = accent;
            this.you = you;
            this.agent = agent;
            this.ok = ok;
            this.warn = warn;
            this.plate = plate;
            this.plateDrag = plateDrag;
            this.hairline = hairline;
            this.scrim = scrim;
            this.halo = halo;
            this.menuBg = menuBg;
            this.menuRowPressed = menuRowPressed;
        }
    }

    static final Palette DARK = new Palette(
            0xFFF4F4F6, 0xE0F4F4F6, 0xFF9B9BA4, 0xFFFFD76A, 0xFF7C5CFF, 0xFFF5A623,
            0xFF35C759, 0xFFFF8A3D, 0xB80E0F12, 0x800E0F12, 0x24FFFFFF, 0x6B090A0C,
            0xB8000000, 0xDB121317, 0x14FFFFFF);

    static final Palette LIGHT = new Palette(
            0xFF141519, 0xE6141519, 0xFF6B6C76, 0xFFB87400, 0xFF5B3FE0, 0xFFC06B00,
            0xFF1F8F3D, 0xFFC24A00, 0xC2FCFCFD, 0x8AFCFCFD, 0x1A000000, 0x85FFFFFF,
            0xE0FFFFFF, 0xE1FCFCFD, 0x0D000000);

    static Palette palette(boolean light) {
        return light ? LIGHT : DARK;
    }

    /**
     * Ribbon height in dp for a system font scale. Beyond {@link #FONT_SCALE_CLAMP}
     * the ribbon takes one step up and then stops: an unbounded ribbon would wrap,
     * and wrapping breaks the whole no-reflow guarantee.
     */
    static int ribbonHeightDp(float fontScale) {
        return fontScale > FONT_SCALE_CLAMP ? RIBBON_H_LARGE_DP : RIBBON_H_DP;
    }

    /** Text size in sp, clamped the same way so the glyphs fit the clamped box. */
    static float textScale(float fontScale) {
        return Math.min(fontScale <= 0f ? 1f : fontScale, FONT_SCALE_CLAMP);
    }
}

package ai.moa.assistant;

final class MoaColors {
    // Native black theme: opaque true-black surfaces (OLED black, no tint and
    // no glass translucency), structure carried by white hairline borders, one
    // amber-to-gold accent, violet reserved for the user's own bubbles.
    static final int INK = 0xFF0B0C0E;           // dark text on gold fills
    static final int PAPER = 0xFFF4F4F6;         // primary text on dark
    static final int MUTED = 0xFF9B9BA4;         // secondary text
    static final int GOLD = 0xFFFFD76A;
    static final int AMBER = 0xFFF5A623;
    static final int EMBER = 0xFFFF8A3D;
    static final int VIOLET = 0xFF7C5CFF;
    static final int GREEN = 0xFF35C759;
    static final int RED = 0xFFFF453A;

    // Semantic status colors. Positive/ready is the brand amber-gold;
    // needs-attention is ember.
    static final int OK = GOLD;
    static final int WARN = EMBER;

    // Surfaces. Cards are opaque so underlying app content never bleeds
    // through; elevation reads from the hairline steps, not translucency.
    static final int SURFACE_0 = 0xFF000000;
    static final int PANEL_BG = 0xFF000000;      // opaque true-black overlay card
    static final int APP_CARD_BG = 0xFF000000;   // opaque true-black full-app card
    static final int PANEL_BORDER = 0x24FFFFFF;  // 14% white hairline
    // Assistant bubble fill only — one neutral step above the true-black card
    // so bubbles stay distinguishable. Not a card/surface background.
    static final int RAISED = 0xFF121212;
    static final int RAISED_BORDER = 0x17FFFFFF; // 9% white hairline
    static final int COMPOSER_BG = 0xFF0A0A0A;
    static final int COMPOSER_BORDER = 0x24FFFFFF;

    // User bubble: violet tint.
    static final int USER_BG = 0x267C5CFF;
    static final int USER_BORDER = 0x407C5CFF;

    // Opaque warm near-black disc painted behind the lion mark. Mirrors the
    // adaptive launcher icon's ic_launcher_background (#161310) so the mark's
    // dark eyes read on light content instead of vanishing on a transparent
    // window. Alpha is 1 on purpose; the window stays translucent for roundness.
    static final int MARK_BACKING = 0xFF161310;

    private MoaColors() {
    }
}

package ai.moa.assistant;

final class MoaColors {
    // Warm-ember dark glass theme, aligned with the browser extension's
    // overlay tokens (--agee-*): neutral near-black surfaces (no green cast),
    // one amber-to-gold accent, violet reserved for the user's own bubbles.
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

    // Surfaces (dark glass: layered translucency reads as elevation).
    static final int SURFACE_0 = 0xFF0B0C0E;
    static final int PANEL_BG = 0xF50E0F12;      // ~rgba(14,15,18,0.96)
    static final int PANEL_BORDER = 0x24FFFFFF;  // 14% white hairline
    static final int RAISED = 0xFF17181C;        // assistant bubble / card fill
    static final int RAISED_BORDER = 0x17FFFFFF; // 9% white hairline
    static final int COMPOSER_BG = 0xFF101114;
    static final int COMPOSER_BORDER = 0x24FFFFFF;

    // User bubble: violet tint.
    static final int USER_BG = 0x267C5CFF;
    static final int USER_BORDER = 0x407C5CFF;

    private MoaColors() {
    }
}

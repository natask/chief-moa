package ag.companion;

final class MoaColors {
    // Obsidian Atelier: warm mineral neutrals with a restrained brass accent.
    // Gold is a signal, not a surface; most controls stay quiet until selected.
    static final int INK = 0xFF11100E;
    static final int PAPER = 0xFFF5F1E8;
    static final int MUTED = 0xFFA19D94;
    static final int MUTED_DARK = 0xFF716E68;
    static final int GOLD = 0xFFE1BB68;
    static final int GOLD_BRIGHT = 0xFFF3D58F;
    static final int AMBER = 0xFFD99A45;
    static final int EMBER = 0xFFE98255;
    static final int VIOLET = 0xFF8C79E8;
    static final int GREEN = 0xFF65C18C;
    static final int RED = 0xFFE66C64;

    // Semantic status colors. Positive/ready is the brand amber-gold;
    // needs-attention is ember.
    static final int OK = GOLD;
    static final int WARN = EMBER;

    // Surfaces (dark glass: layered translucency reads as elevation).
    static final int SURFACE_0 = 0xFF09090B;
    static final int SURFACE_1 = 0xFF0E0E11;
    static final int PANEL_BG = 0xFA101013;
    static final int PANEL_BORDER = 0x1FFFFFFF;
    static final int RAISED = 0xFF17171B;
    static final int RAISED_2 = 0xFF1D1D22;
    static final int RAISED_BORDER = 0x18FFFFFF;
    static final int COMPOSER_BG = 0xFF111114;
    static final int COMPOSER_BORDER = 0x24FFFFFF;
    static final int GOLD_WASH = 0x20E1BB68;
    static final int GOLD_BORDER = 0x66E1BB68;

    // User bubble: violet tint.
    static final int USER_BG = 0x267C5CFF;
    static final int USER_BORDER = 0x407C5CFF;

    // Opaque warm near-black disc painted behind the lion mark. Mirrors the
    // adaptive launcher icon's ic_launcher_background (#161310) so the mark's
    // dark eyes read on light content instead of vanishing on a transparent
    // window. Alpha is 1 on purpose; the window stays translucent for roundness.
    static final int MARK_BACKING = 0xFF17130D;

    private MoaColors() {
    }
}

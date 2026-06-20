package ai.moa.assistant;

final class MoaColors {
    // Dark Moa theme. Deep teal-black ground, teal + gold + violet accents,
    // paper text, muted secondary text.
    static final int INK = 0xFF07110D;
    static final int PAPER = 0xFFF7FFF1;
    static final int MUTED = 0xFF9FB3AC;
    static final int MINT = 0xFF61E5C6;
    static final int TEAL = 0xFF34E0C0;
    static final int GOLD = 0xFFF4D35E;
    static final int VIOLET = 0xFF7C5CFF;
    static final int EMBER = 0xFFFF8B4A;

    // Surfaces.
    static final int PANEL_BG = 0xF20A1612;
    static final int PANEL_BORDER = 0x1FFFFFFF;
    static final int RAISED = 0xFF14211C;        // assistant bubble fill
    static final int RAISED_BORDER = 0x1AFFFFFF;
    static final int COMPOSER_BG = 0xFF0F1A16;
    static final int COMPOSER_BORDER = 0x22FFFFFF;

    // User bubble: teal-violet tint.
    static final int USER_BG = 0x2661E5C6;
    static final int USER_BORDER = 0x4061E5C6;

    private MoaColors() {
    }
}

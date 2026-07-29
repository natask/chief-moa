package ag.companion;

/**
 * The three copyable forms of one spoken turn.
 *
 * <ul>
 *   <li>{@link Variant#LITERAL} — exactly what the provider transcribed. Never
 *       rewritten, never silently replaced.</li>
 *   <li>{@link Variant#CORRECTED} — the same text with recognition errors fixed.</li>
 *   <li>{@link Variant#POLISHED} — rewritten in the user's own style.</li>
 * </ul>
 *
 * This follows the derived-revision contract in the
 * {@code voice-capture-notebook} spec: a writing skill produces a candidate
 * beside the literal transcript, and the literal transcript stays byte-for-byte
 * unchanged and selectable.
 *
 * The polished form is the DEFAULT copy when it exists. Nothing produces
 * CORRECTED or POLISHED today — no gateway endpoint emits them — so in practice
 * this degrades to literal-only, and {@link #available} reports honestly which
 * forms have backing data rather than fabricating the missing ones.
 */
final class MoaTranscriptVariants {
    enum Variant {
        LITERAL,
        CORRECTED,
        POLISHED
    }

    private String literal = "";
    private String corrected = "";
    private String polished = "";

    void setLiteral(String value) {
        literal = safe(value);
    }

    void setCorrected(String value) {
        corrected = safe(value);
    }

    void setPolished(String value) {
        polished = safe(value);
    }

    void clear() {
        literal = "";
        corrected = "";
        polished = "";
    }

    boolean isEmpty() {
        return literal.isEmpty() && corrected.isEmpty() && polished.isEmpty();
    }

    String text(Variant variant) {
        if (variant == null) {
            return "";
        }
        switch (variant) {
            case POLISHED:
                return polished;
            case CORRECTED:
                return corrected;
            default:
                return literal;
        }
    }

    boolean has(Variant variant) {
        return !text(variant).isEmpty();
    }

    /** Most-polished first. What a plain "Copy" puts on the clipboard. */
    Variant defaultVariant() {
        if (has(Variant.POLISHED)) {
            return Variant.POLISHED;
        }
        if (has(Variant.CORRECTED)) {
            return Variant.CORRECTED;
        }
        return Variant.LITERAL;
    }

    String defaultText() {
        return text(defaultVariant());
    }

    /** The forms that actually exist, in menu order. */
    java.util.List<Variant> available() {
        java.util.List<Variant> present = new java.util.ArrayList<>();
        for (Variant variant : new Variant[]{Variant.POLISHED, Variant.CORRECTED, Variant.LITERAL}) {
            if (has(variant)) {
                present.add(variant);
            }
        }
        return present;
    }

    static String label(Variant variant) {
        if (variant == null) {
            return "Copy";
        }
        switch (variant) {
            case POLISHED:
                return "Copy polished";
            case CORRECTED:
                return "Copy corrected";
            default:
                return "Copy literal";
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

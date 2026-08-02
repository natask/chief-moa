package ag.companion;

import java.util.Locale;

/** Presentation-only choice. It never changes invocation or turn semantics. */
enum MoaPresentationStyle {
    COMPANION,
    MINIMAL;

    static MoaPresentationStyle fromPersisted(String value) {
        String normalized = value == null ? "" : value.trim().toUpperCase(Locale.US);
        for (MoaPresentationStyle style : values()) {
            if (style.name().equals(normalized)) return style;
        }
        return COMPANION;
    }
}

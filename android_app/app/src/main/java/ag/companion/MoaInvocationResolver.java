package ag.companion;

import android.content.Intent;

/** Maps every exported launcher/Assistant entry to one bounded Android-owned mode. */
final class MoaInvocationResolver {
    static final String ACTION_DICTATION = "ag.companion.action.START_DICTATION";
    static final String ACTION_ASSISTANT = "ag.companion.action.START_ASSISTANT";
    static final String ACTION_HANDS_FREE = "ag.companion.action.START_HANDS_FREE";
    static final String ACTION_CONTROL_CENTER = "ag.companion.action.SHOW_CONTROL_CENTER";

    enum Invocation {
        DICTATION,
        ASSISTANT,
        HANDS_FREE,
        CONTROL_CENTER
    }

    private MoaInvocationResolver() {
    }

    static Invocation resolve(String action) {
        if (Intent.ACTION_MAIN.equals(action) || ACTION_DICTATION.equals(action)) {
            return Invocation.DICTATION;
        }
        if (ACTION_HANDS_FREE.equals(action)) {
            return Invocation.HANDS_FREE;
        }
        if (ACTION_CONTROL_CENTER.equals(action)) {
            return Invocation.CONTROL_CENTER;
        }
        // Preserve the existing exported-entry default: system Assistant actions,
        // the explicit Assistant shortcut, and an absent/unrecognized action all
        // enter the reasoning-capable assistant rather than literal dictation.
        return Invocation.ASSISTANT;
    }
}

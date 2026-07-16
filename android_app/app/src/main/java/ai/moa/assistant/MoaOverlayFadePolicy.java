package ai.moa.assistant;

// Outside-tap fade contract for the overlay family: the lion orb plus its
// attached chat panel and voice transcript card. A tap that lands outside every
// family window fades the whole family to FADED_ALPHA — nothing closes, no
// draft, transcript, message, or live voice turn is lost. The first touch on
// any faded family window restores full opacity and is consumed, so a wake tap
// can never also press a button, start a voice gesture, or swipe a row.
//
// Every overlay window watches outside touches, so one physical tap is
// reported more than once: the touched family window sees ACTION_DOWN while
// each sibling window reports ACTION_OUTSIDE for the same gesture. Android
// gives no cross-window ordering guarantee and zeroes ACTION_OUTSIDE
// coordinates, so the two reports are correlated by event time instead of
// position: an outside report only becomes a fade after OUTSIDE_CONFIRM_MS
// passes with no family window claiming the same gesture.
//
// The policy is pure state (no Android types) so the fade/restore/consume
// decisions are unit-testable on the JVM. OverlayService owns the actual
// animations, scheduling, and window bookkeeping.
final class MoaOverlayFadePolicy {
    // Faded family opacity. Dim enough to read as "parked", bright enough that
    // the lion and any streaming reply stay legible.
    static final float FADED_ALPHA = 0.35f;
    // How long an outside report waits for a family window to claim the same
    // gesture before the fade commits. Cross-window dispatch of one gesture
    // lands within a frame or two; 80ms is imperceptible next to the fade
    // animation itself.
    static final long OUTSIDE_CONFIRM_MS = 80;

    enum TouchKind {
        DOWN,
        MOVE,
        UP,
        CANCEL,
        OUTSIDE,
        OTHER
    }

    enum Action {
        // Not the family's business: hand the event to the window's own logic.
        PASS,
        // Mid-gesture event of a consumed wake tap: swallow it.
        CONSUME,
        // First touch on a faded family window: restore full opacity and
        // swallow the whole gesture.
        RESTORE_AND_CONSUME,
        // Outside report: schedule a deferred fade confirm for this gesture.
        FADE_REQUEST
    }

    private boolean faded;
    private boolean fadeHold;
    private long lastFamilyTouchAtMs = Long.MIN_VALUE;
    private long pendingOutsideAtMs = Long.MIN_VALUE;

    boolean isFaded() {
        return faded;
    }

    // Keyboard guard. While the chat composer is engaged (focused with the IME
    // up or imminently up), outside reports must not park the family: taps on
    // the keyboard are conversation, not disengagement, and cross-window
    // dispatch cannot tell an IME tap from an app tap once coordinates are
    // zeroed. Engaging the hold also voids any in-flight fade confirm. The
    // hold never touches the faded flag itself: an already-parked family still
    // wakes only through a family touch or an explicit restore.
    void setFadeHold(boolean held) {
        fadeHold = held;
        if (held) {
            pendingOutsideAtMs = Long.MIN_VALUE;
        }
    }

    boolean isFadeHeld() {
        return fadeHold;
    }

    // One gate per overlay window. The consumed-gesture flag is per window
    // because each window receives its own independent touch stream.
    WindowGate newWindowGate() {
        return new WindowGate();
    }

    // An outside report arrived. True when the caller should schedule a
    // confirmFade(eventTimeMs) after OUTSIDE_CONFIRM_MS; false when the
    // keyboard hold is engaged or a family window already claimed this gesture
    // (same or older event time).
    boolean shouldScheduleFadeConfirm(long eventTimeMs) {
        if (fadeHold || eventTimeMs <= lastFamilyTouchAtMs) {
            return false;
        }
        pendingOutsideAtMs = eventTimeMs;
        return true;
    }

    // The deferred confirm fired. True when the family should fade now: the
    // outside report was neither voided by a family touch nor superseded by a
    // newer outside gesture, and the family is not already faded.
    boolean confirmFade(long eventTimeMs) {
        if (pendingOutsideAtMs != eventTimeMs) {
            return false;
        }
        pendingOutsideAtMs = Long.MIN_VALUE;
        if (faded) {
            return false;
        }
        faded = true;
        return true;
    }

    // Programmatic wake: a surface is being shown or explicitly dismissed, so
    // the family returns to full opacity. True when it was actually faded.
    boolean restore() {
        pendingOutsideAtMs = Long.MIN_VALUE;
        boolean wasFaded = faded;
        faded = false;
        return wasFaded;
    }

    final class WindowGate {
        private boolean consumingGesture;

        Action onTouch(TouchKind kind, long eventTimeMs) {
            if (kind == TouchKind.OUTSIDE) {
                return Action.FADE_REQUEST;
            }
            if (kind == TouchKind.DOWN) {
                // This gesture landed in the family: void any pending fade the
                // same gesture raised through a sibling window's outside report.
                lastFamilyTouchAtMs = eventTimeMs;
                pendingOutsideAtMs = Long.MIN_VALUE;
                if (faded) {
                    faded = false;
                    consumingGesture = true;
                    return Action.RESTORE_AND_CONSUME;
                }
                consumingGesture = false;
                return Action.PASS;
            }
            if (consumingGesture) {
                if (kind == TouchKind.UP || kind == TouchKind.CANCEL) {
                    consumingGesture = false;
                }
                return Action.CONSUME;
            }
            return Action.PASS;
        }
    }
}

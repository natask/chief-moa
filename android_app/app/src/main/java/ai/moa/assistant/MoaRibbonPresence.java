package ai.moa.assistant;

/**
 * The opacity state machine for the overlay unit.
 *
 * The requirement in the user's words is "all of it should be basically
 * transparent unless I'm personally pressing down on something". That is exactly
 * the invariant encoded here: nothing in the unit paints a filled plate outside
 * {@code ENGAGED} / {@code DRAGGING}, and both of those states require a finger.
 *
 * Android has no hover, so the browser's proximity pre-light state does not
 * exist: {@code DORMANT -> ENGAGED} on touch is the only path.
 *
 * Pure Java so the transitions and their timers are unit tested. The clock is
 * passed in rather than read, so the linger and latch windows are testable
 * without waiting on them.
 */
final class MoaRibbonPresence {
    enum State {
        DORMANT,
        AMBIENT,
        ENGAGED,
        DRAGGING
    }

    private boolean hasText;
    private boolean streaming;
    private boolean pointerDown;
    private boolean dragging;
    private boolean menuOpen;
    private long latchUntilMs;
    private long lingerUntilMs;

    void setHasText(boolean value) {
        hasText = value;
        if (!value) {
            lingerUntilMs = 0;
        }
    }

    void setStreaming(boolean value) {
        streaming = value;
    }

    void setPointerDown(boolean value) {
        pointerDown = value;
    }

    void setDragging(boolean value) {
        dragging = value;
        if (value) {
            pointerDown = true;
        }
    }

    void setMenuOpen(boolean value) {
        menuOpen = value;
    }

    boolean menuOpen() {
        return menuOpen;
    }

    /** A tap latches ENGAGED so the copy rail stays reachable after the finger lifts. */
    void latch(long nowMs) {
        latchUntilMs = nowMs + MoaRibbonTokens.DUR_LATCH_MS;
    }

    /** Re-arm the latch on continued interaction without restarting the state. */
    void rearmLatch(long nowMs) {
        if (latchUntilMs > 0) {
            latch(nowMs);
        }
    }

    /** Released early by a press outside the unit, or by a second tap on the ribbon. */
    void releaseLatch() {
        latchUntilMs = 0;
    }

    boolean latched(long nowMs) {
        return nowMs < latchUntilMs;
    }

    /**
     * Start the post-turn linger. A ribbon that is latched, engaged or holding a
     * menu open does not start its timer until it returns to ambient, so a menu
     * cannot be yanked away mid-read.
     */
    void startLinger(long nowMs, long durationMs) {
        if (state(nowMs) == State.ENGAGED || state(nowMs) == State.DRAGGING) {
            return;
        }
        lingerUntilMs = nowMs + durationMs;
    }

    void clearLinger() {
        lingerUntilMs = 0;
    }

    long lingerDeadlineMs() {
        return lingerUntilMs;
    }

    State state(long nowMs) {
        if (dragging) {
            return State.DRAGGING;
        }
        if (pointerDown || menuOpen || nowMs < latchUntilMs) {
            return State.ENGAGED;
        }
        if (hasText && (streaming || nowMs < lingerUntilMs)) {
            return State.AMBIENT;
        }
        return State.DORMANT;
    }

    /** How long a finished reply should stay readable before it fades. */
    static long lingerFor(boolean reply, boolean readOnly) {
        if (!reply) {
            return MoaRibbonTokens.LINGER_YOU_MS;
        }
        return readOnly ? MoaRibbonTokens.LINGER_UNREAD_MS : MoaRibbonTokens.LINGER_REPLY_MS;
    }

    static float companionAlpha(State state) {
        switch (state) {
            case AMBIENT:
                return MoaRibbonTokens.COMPANION_AMBIENT_ALPHA;
            case ENGAGED:
            case DRAGGING:
                return MoaRibbonTokens.COMPANION_ENGAGED_ALPHA;
            default:
                return MoaRibbonTokens.COMPANION_DORMANT_ALPHA;
        }
    }

    static float ribbonAlpha(State state) {
        return state == State.DORMANT ? 0f : 1f;
    }

    /**
     * How solid the ribbon's plate is. Zero everywhere the user is not touching:
     * ambient legibility comes from the halo plus a per-glyph scrim that hugs the
     * text, so an empty ribbon paints nothing at all.
     */
    static float plateAlpha(State state, boolean highContrast) {
        switch (state) {
            case ENGAGED:
                return 1f;
            case DRAGGING:
                return 0.70f;
            case AMBIENT:
                // The only sanctioned occluding ambient, and only because the user
                // asked the system for reduced transparency.
                return highContrast ? 0.86f : 0f;
            default:
                return 0f;
        }
    }

    /** The per-glyph scrim replaces the plate whenever there is no plate. */
    static boolean scrimVisible(State state, boolean highContrast) {
        return state == State.AMBIENT && !highContrast;
    }

    /** Whether the ribbon window should accept touch at all in this state. */
    static boolean acceptsTouch(State state, boolean hasText) {
        return hasText || state == State.ENGAGED || state == State.DRAGGING;
    }

    /** The copy rail is revealed only once the user is actually on the ribbon. */
    static boolean railVisible(State state) {
        return state == State.ENGAGED;
    }

    static long solidifyDurationMs(State from, State to) {
        if (to == State.ENGAGED || to == State.DRAGGING) {
            return MoaRibbonTokens.DUR_SOLIDIFY_MS;
        }
        if (to == State.AMBIENT) {
            return MoaRibbonTokens.DUR_SOFTEN_MS;
        }
        return from == State.DORMANT ? MoaRibbonTokens.DUR_SOLIDIFY_MS : MoaRibbonTokens.DUR_SLOW_MS;
    }
}

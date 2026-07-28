package ai.moa.assistant;

/**
 * Bounds hands-free continuous capture.
 *
 * The loop re-arms the microphone {@code CONTINUOUS_VOICE_RESTART_MS} after every
 * turn ends, with no new tap or hold. Until this class existed there was no idle
 * timeout, no maximum session duration, and no silence bound: one deliberate tap
 * armed the microphone indefinitely, and a phone set down kept capturing. On
 * 2026-07-18 that recorded a private family conversation the user did not know
 * was being captured.
 *
 * Two bounds, both deliberately generous — hands-free capture is a feature the
 * user relies on, so under-correcting is better than breaking it:
 *
 * <ul>
 *   <li>{@link #MAX_SILENT_TURNS} consecutive turns that produced no real speech
 *       end the loop. Any real transcript resets the count to zero.</li>
 *   <li>{@link #MAX_SESSION_MS} from the moment the loop was armed ends it
 *       regardless of how much speech there has been.</li>
 * </ul>
 *
 * Leaving is not a lockout. The microphone is released, the overlay says what
 * happened, and the normal gesture re-arms immediately.
 *
 * The teardown runs through {@link Capture} so that releasing the microphone on
 * both exit paths is a testable fact rather than an assumption.
 */
final class MoaContinuousCaptureLoop {

    /**
     * Consecutive silent turns tolerated before the loop lets go.
     *
     * Each empty cycle costs a provider round trip plus the re-arm delay, so five
     * of them is roughly half a minute to a minute of real quiet. Long enough
     * that pausing to think, reading something mid-sentence, or one bad
     * recognition never drops the user; short enough that a phone set down on a
     * table stops listening on its own.
     */
    static final int MAX_SILENT_TURNS = 5;

    /**
     * Hard ceiling on one continuous session, measured from when it was armed.
     *
     * Long enough to dictate through a meeting or a long walk without noticing
     * it; short enough that "armed indefinitely" is no longer possible.
     */
    static final long MAX_SESSION_MS = 45L * 60L * 1000L;

    enum Exit {
        SILENCE,
        DURATION
    }

    /** The capture-owning side of the exit. Implemented by OverlayService. */
    interface Capture {
        /** Drop the queued re-arm so no microphone is opened after this. */
        void cancelPendingRestart();

        /** Release the microphone warmed in advance of the next turn. */
        void releaseWarmMic();

        /** Tear down any capture session still holding the microphone. */
        void stopActiveCapture();

        /** Say what happened, so the visible state matches reality. */
        void announceExit(String notice);

        /** Return to a resting state the normal gesture can re-arm. */
        void markReadyToRearm();
    }

    private final Capture capture;
    private boolean armed;
    private long armedAtMs;
    private int silentTurns;

    MoaContinuousCaptureLoop(Capture capture) {
        this.capture = capture;
    }

    void arm(long nowMs) {
        if (armed) {
            return;
        }
        armed = true;
        armedAtMs = nowMs;
        silentTurns = 0;
    }

    /** Every existing exit path funnels here; re-arming requires a fresh arm(). */
    void disarm() {
        armed = false;
        armedAtMs = 0;
        silentTurns = 0;
    }

    boolean armed() {
        return armed;
    }

    int consecutiveSilentTurns() {
        return silentTurns;
    }

    long elapsedMs(long nowMs) {
        return armed ? Math.max(0, nowMs - armedAtMs) : 0;
    }

    long remainingMs(long nowMs) {
        return armed ? Math.max(0, MAX_SESSION_MS - elapsedMs(nowMs)) : 0;
    }

    /**
     * The gate in front of the one place the microphone re-arms itself.
     *
     * @param heardSpeech whether the turn that just ended produced a real
     *                    transcript, as opposed to silence or a synthetic
     *                    transport string
     * @return true when the loop may continue; false when it has just left, in
     *         which case the microphone is already released
     */
    boolean allowRearm(boolean heardSpeech, long nowMs) {
        if (!armed) {
            return false;
        }
        silentTurns = heardSpeech ? 0 : silentTurns + 1;
        // The duration cap is checked first because it applies regardless of
        // activity; a long session that also went quiet reports the harder bound.
        if (elapsedMs(nowMs) >= MAX_SESSION_MS) {
            leave(Exit.DURATION);
            return false;
        }
        if (silentTurns >= MAX_SILENT_TURNS) {
            leave(Exit.SILENCE);
            return false;
        }
        return true;
    }

    private void leave(Exit exit) {
        String notice = notice(exit);
        disarm();
        capture.cancelPendingRestart();
        capture.releaseWarmMic();
        capture.stopActiveCapture();
        capture.announceExit(notice);
        capture.markReadyToRearm();
    }

    static String notice(Exit exit) {
        if (exit == Exit.DURATION) {
            return "Stopped listening after " + (MAX_SESSION_MS / 60000L)
                    + " minutes. Tap to start again.";
        }
        return "Stopped listening after a quiet stretch. Tap to start again.";
    }
}

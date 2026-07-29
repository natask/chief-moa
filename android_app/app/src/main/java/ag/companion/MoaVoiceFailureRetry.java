package ag.companion;

/**
 * One-shot authority for a visible voice-failure recovery action.
 *
 * A retry belongs to the streaming generation that surfaced the failure.
 * Starting, replacing, or intentionally closing a session invalidates it, and
 * consuming it exactly once prevents double taps from opening two microphones.
 */
final class MoaVoiceFailureRetry {
    private int generation = -1;
    private boolean available;

    void arm(int generation) {
        this.generation = generation;
        available = true;
    }

    boolean isAvailable(int currentGeneration) {
        return available && generation == currentGeneration;
    }

    boolean consume(int currentGeneration) {
        if (!isAvailable(currentGeneration)) {
            return false;
        }
        available = false;
        return true;
    }

    boolean consumeAndRun(int currentGeneration, Runnable freshCapture) {
        if (freshCapture == null || !consume(currentGeneration)) {
            return false;
        }
        freshCapture.run();
        return true;
    }

    int invalidateForIntentionalTeardown(int currentGeneration, boolean controllerPresent) {
        invalidate();
        return controllerPresent ? currentGeneration + 1 : currentGeneration;
    }

    void invalidate() {
        available = false;
        generation = -1;
    }
}

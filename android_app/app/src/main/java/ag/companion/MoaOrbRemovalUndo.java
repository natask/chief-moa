package ag.companion;

/**
 * Makes dropping the unit on the remove target reversible.
 *
 * Removal used to be a one-way gesture: drop, service stops, and the only way
 * back was the launcher. Combined with an over-large invisible hit zone that was
 * reported as too sensitive, an accidental drag near the bottom of the screen
 * destroyed the overlay outright. Bounding the target (see
 * {@link MoaOrbOverlayGeometry#removeTargetBounds}) makes it harder to hit by
 * accident; this makes hitting it recoverable.
 *
 * The service stays alive for {@link #WINDOW_MS} after the drop with every unit
 * window detached, showing only an undo chip. Undo puts the companion back at
 * the position it was dragged from — not where it was dropped — so the user's
 * placement survives the mistake. Silence stops the service as before.
 */
final class MoaOrbRemovalUndo {
    static final long WINDOW_MS = 5000;

    private boolean armed;
    private int restoreX;
    private int restoreY;
    private long expiresAtMs;

    /**
     * @param dragStartX companion x at ACTION_DOWN, not at the drop
     * @param dragStartY companion y at ACTION_DOWN, not at the drop
     */
    void arm(int dragStartX, int dragStartY, long nowMs) {
        armed = true;
        restoreX = dragStartX;
        restoreY = dragStartY;
        expiresAtMs = nowMs + WINDOW_MS;
    }

    boolean pending(long nowMs) {
        return armed && nowMs < expiresAtMs;
    }

    boolean expired(long nowMs) {
        return armed && nowMs >= expiresAtMs;
    }

    long remainingMs(long nowMs) {
        return armed ? Math.max(0, expiresAtMs - nowMs) : 0;
    }

    int restoreX() {
        return restoreX;
    }

    int restoreY() {
        return restoreY;
    }

    /** Take the undo. Returns false when the window has already closed. */
    boolean consume(long nowMs) {
        if (!pending(nowMs)) {
            return false;
        }
        armed = false;
        return true;
    }

    void disarm() {
        armed = false;
        expiresAtMs = 0;
    }
}

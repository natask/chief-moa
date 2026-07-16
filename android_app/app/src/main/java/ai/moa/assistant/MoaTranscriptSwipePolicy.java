package ai.moa.assistant;

final class MoaTranscriptSwipePolicy {
    enum Decision {
        WAIT,
        SWIPE,
        RELEASE
    }

    private MoaTranscriptSwipePolicy() {
    }

    static Decision decide(float dx, float dy, int touchSlop, long heldMs,
                           long longPressMs, boolean selectionActive) {
        if (selectionActive || heldMs >= longPressMs) {
            return Decision.RELEASE;
        }
        float horizontal = Math.abs(dx);
        float vertical = Math.abs(dy);
        if (horizontal > touchSlop && horizontal > vertical * 1.4f) {
            return Decision.SWIPE;
        }
        return vertical > touchSlop ? Decision.RELEASE : Decision.WAIT;
    }

    static boolean shouldDismiss(float dx, float rowWidth, int minimumPx) {
        return Math.abs(dx) > Math.max(1f, rowWidth) * 0.33f
                || Math.abs(dx) > minimumPx;
    }
}

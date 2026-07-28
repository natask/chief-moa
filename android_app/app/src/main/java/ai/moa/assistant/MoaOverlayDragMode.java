package ai.moa.assistant;

/** Pure state machine for the bounded, companion-only overlay drag. */
final class MoaOverlayDragMode {
    enum Phase { IDLE, DRAGGING }

    static final class FramePlan {
        final boolean submitCompanion;
        final boolean submitDependents;

        FramePlan(boolean submitCompanion, boolean submitDependents) {
            this.submitCompanion = submitCompanion;
            this.submitDependents = submitDependents;
        }
    }

    private Phase phase = Phase.IDLE;

    boolean begin() {
        if (phase == Phase.DRAGGING) return false;
        phase = Phase.DRAGGING;
        return true;
    }

    FramePlan movingFrame() {
        return new FramePlan(true, phase != Phase.DRAGGING);
    }

    boolean finish() {
        if (phase != Phase.DRAGGING) return false;
        phase = Phase.IDLE;
        return true;
    }

    boolean isDragging() {
        return phase == Phase.DRAGGING;
    }
}

package ai.moa.assistant;

/** Coalesces repeated state changes into one latest-state update per display frame. */
final class MoaFrameCoalescer {
    interface Scheduler {
        void postOnNextFrame(Runnable callback);

        void remove(Runnable callback);
    }

    private final Scheduler scheduler;
    private final Runnable applyLatest;
    private final Runnable frameCallback = this::applyScheduledFrame;
    private boolean scheduled;

    MoaFrameCoalescer(Scheduler scheduler, Runnable applyLatest) {
        this.scheduler = scheduler;
        this.applyLatest = applyLatest;
    }

    void request() {
        if (scheduled) {
            return;
        }
        scheduled = true;
        scheduler.postOnNextFrame(frameCallback);
    }

    void flush() {
        if (scheduled) {
            scheduler.remove(frameCallback);
            scheduled = false;
        }
        applyLatest.run();
    }

    void cancel() {
        if (!scheduled) {
            return;
        }
        scheduler.remove(frameCallback);
        scheduled = false;
    }

    boolean isScheduled() {
        return scheduled;
    }

    private void applyScheduledFrame() {
        if (!scheduled) {
            return;
        }
        scheduled = false;
        applyLatest.run();
    }
}

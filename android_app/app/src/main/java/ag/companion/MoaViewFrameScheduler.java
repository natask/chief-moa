package ag.companion;

import android.view.View;

final class MoaViewFrameScheduler implements MoaFrameCoalescer.Scheduler {
    private final View view;

    MoaViewFrameScheduler(View view) {
        this.view = view;
    }

    @Override
    public void postOnNextFrame(Runnable callback) {
        view.postOnAnimation(callback);
    }

    @Override
    public void remove(Runnable callback) {
        view.removeCallbacks(callback);
    }
}

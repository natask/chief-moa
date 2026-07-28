package ai.moa.assistant;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public final class MoaOverlayGroupDragListenerTest {
    @Test
    public void manyMovesRequestOneFrameAndApplyOrbOnce() {
        Context context = RuntimeEnvironment.getApplication();
        WindowManager.LayoutParams params = new WindowManager.LayoutParams();
        params.x = 100;
        params.y = 120;
        params.width = 67;
        params.height = 67;
        FakeScheduler scheduler = new FakeScheduler();
        int[] orbUpdates = {0};
        MoaFrameCoalescer coalescer =
                new MoaFrameCoalescer(scheduler, () -> orbUpdates[0]++);
        MoaOverlayGroupDragListener listener = new MoaOverlayGroupDragListener(
                context, params, 67, 16, () -> { }, coalescer::request);
        View header = new View(context);

        listener.onTouch(header, event(MotionEvent.ACTION_DOWN, 100, 120));
        for (int i = 1; i <= 8; i++) {
            listener.onTouch(header, event(MotionEvent.ACTION_MOVE, 100 + i * 10, 120 + i * 4));
        }

        assertEquals(1, scheduler.postCount);
        assertEquals(0, orbUpdates[0]);
        assertEquals(180, params.x);
        assertEquals(152, params.y);
        scheduler.runFrame();
        assertEquals(1, orbUpdates[0]);
    }

    private static MotionEvent event(int action, float x, float y) {
        return MotionEvent.obtain(0, 0, action, x, y, 0);
    }

    private static final class FakeScheduler implements MoaFrameCoalescer.Scheduler {
        Runnable callback;
        int postCount;

        @Override public void postOnNextFrame(Runnable callback) {
            this.callback = callback;
            postCount++;
        }

        @Override public void remove(Runnable callback) {
            if (this.callback == callback) this.callback = null;
        }

        void runFrame() {
            Runnable pending = callback;
            callback = null;
            pending.run();
        }
    }
}

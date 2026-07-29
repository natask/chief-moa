package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaFrameCoalescerTest {
    @Test
    public void repeatedRequestsApplyLatestStateOnceOnNextFrame() {
        FakeScheduler scheduler = new FakeScheduler();
        int[] latest = {0};
        int[] applied = {-1};
        int[] applyCount = {0};
        MoaFrameCoalescer coalescer = new MoaFrameCoalescer(scheduler, () -> {
            applied[0] = latest[0];
            applyCount[0]++;
        });

        latest[0] = 1;
        coalescer.request();
        latest[0] = 2;
        coalescer.request();
        latest[0] = 3;
        coalescer.request();

        assertEquals(1, scheduler.postCount);
        assertTrue(coalescer.isScheduled());
        scheduler.runFrame();
        assertEquals(3, applied[0]);
        assertEquals(1, applyCount[0]);
        assertFalse(coalescer.isScheduled());
    }

    @Test
    public void flushAppliesLatestStateAndMakesPendingFrameInert() {
        FakeScheduler scheduler = new FakeScheduler();
        int[] applyCount = {0};
        MoaFrameCoalescer coalescer = new MoaFrameCoalescer(scheduler, () -> applyCount[0]++);

        coalescer.request();
        Runnable staleFrame = scheduler.callback;
        coalescer.flush();

        assertEquals(1, applyCount[0]);
        assertEquals(1, scheduler.removeCount);
        assertFalse(coalescer.isScheduled());
        staleFrame.run();
        assertEquals(1, applyCount[0]);
    }

    private static final class FakeScheduler implements MoaFrameCoalescer.Scheduler {
        Runnable callback;
        int postCount;
        int removeCount;

        @Override
        public void postOnNextFrame(Runnable callback) {
            this.callback = callback;
            postCount++;
        }

        @Override
        public void remove(Runnable callback) {
            if (this.callback == callback) {
                this.callback = null;
            }
            removeCount++;
        }

        void runFrame() {
            Runnable pending = callback;
            callback = null;
            pending.run();
        }
    }
}

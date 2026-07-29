package ai.moa.assistant;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public final class MoaPcmPlaybackQueueTest {
    @Test
    public void largeFramesAndTerminalEventsStayPromptWhileFifoDrains() throws Exception {
        CountDownLatch firstWriteStarted = new CountDownLatch(1);
        CountDownLatch allowWrites = new CountDownLatch(1);
        CountDownLatch drained = new CountDownLatch(1);
        List<byte[]> written = new ArrayList<>();
        AtomicBoolean terminalEventProcessed = new AtomicBoolean(false);
        TestListener listener = new TestListener(drained);
        MoaPcmPlaybackQueue queue = new MoaPcmPlaybackQueue(
                2_000_000,
                pcm -> {
                    firstWriteStarted.countDown();
                    try {
                        if (!allowWrites.await(2, TimeUnit.SECONDS)) {
                            return false;
                        }
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                    synchronized (written) {
                        written.add(pcm);
                    }
                    return true;
                },
                listener);

        byte[] first = frame(500_000, (byte) 1);
        byte[] second = frame(500_000, (byte) 2);
        byte[] third = frame(500_000, (byte) 3);
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(first));
        assertTrue(firstWriteStarted.await(1, TimeUnit.SECONDS));

        long started = System.nanoTime();
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(second));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(third));
        queue.finish(); // assistant_audio_done
        terminalEventProcessed.set(true); // turn_done on the socket callback
        long callbackMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);

        assertTrue("socket callback work must not wait for playback", callbackMs < 100L);
        assertTrue(terminalEventProcessed.get());
        assertFalse("playback is intentionally still blocked", drained.await(50, TimeUnit.MILLISECONDS));

        allowWrites.countDown();
        assertTrue(drained.await(2, TimeUnit.SECONDS));
        synchronized (written) {
            assertEquals(3, written.size());
            assertArrayEquals(first, written.get(0));
            assertArrayEquals(second, written.get(1));
            assertArrayEquals(third, written.get(2));
        }
        assertEquals(0, listener.writeFailures.get());
        assertEquals(0, listener.overflows.get());
    }

    @Test
    public void interruptClearsPendingFramesAndRejectsStaleAudio() throws Exception {
        CountDownLatch firstWriteStarted = new CountDownLatch(1);
        CountDownLatch allowFirstWrite = new CountDownLatch(1);
        List<Integer> written = new ArrayList<>();
        TestListener listener = new TestListener(new CountDownLatch(1));
        MoaPcmPlaybackQueue queue = new MoaPcmPlaybackQueue(
                1024,
                pcm -> {
                    firstWriteStarted.countDown();
                    try {
                        allowFirstWrite.await(2, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                    synchronized (written) {
                        written.add((int) pcm[0]);
                    }
                    return true;
                },
                listener);

        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(frame(128, (byte) 1)));
        assertTrue(firstWriteStarted.await(1, TimeUnit.SECONDS));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(frame(128, (byte) 2)));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(frame(128, (byte) 3)));

        queue.cancel();
        allowFirstWrite.countDown();
        assertEquals(0, queue.pendingBytes());
        assertEquals(MoaPcmPlaybackQueue.OfferResult.CLOSED, queue.offer(frame(128, (byte) 4)));
        Thread.sleep(100L);
        synchronized (written) {
            assertTrue("no queued frame may survive an invalidated generation", written.isEmpty());
        }
    }

    @Test
    public void overflowIsBoundedAndVisible() throws Exception {
        CountDownLatch writing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        TestListener listener = new TestListener(new CountDownLatch(1));
        MoaPcmPlaybackQueue queue = new MoaPcmPlaybackQueue(
                10,
                pcm -> {
                    writing.countDown();
                    try {
                        release.await(2, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                    return true;
                },
                listener);

        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(frame(8, (byte) 1)));
        assertTrue(writing.await(1, TimeUnit.SECONDS));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, queue.offer(frame(8, (byte) 2)));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.OVERFLOW, queue.offer(frame(8, (byte) 3)));
        assertEquals(1, listener.overflows.get());
        assertEquals(8, queue.pendingBytes());
        queue.cancel();
        release.countDown();
    }

    private static byte[] frame(int bytes, byte value) {
        byte[] frame = new byte[bytes];
        java.util.Arrays.fill(frame, value);
        return frame;
    }

    private static final class TestListener implements MoaPcmPlaybackQueue.Listener {
        final CountDownLatch drained;
        final AtomicInteger overflows = new AtomicInteger();
        final AtomicInteger writeFailures = new AtomicInteger();

        TestListener(CountDownLatch drained) {
            this.drained = drained;
        }

        @Override
        public void onDrained() {
            drained.countDown();
        }

        @Override
        public void onOverflow(int pendingBytes, int offeredBytes) {
            overflows.incrementAndGet();
        }

        @Override
        public void onWriteFailed() {
            writeFailures.incrementAndGet();
        }
    }
}

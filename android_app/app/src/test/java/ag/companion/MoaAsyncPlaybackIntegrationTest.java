package ag.companion;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public final class MoaAsyncPlaybackIntegrationTest {
    @Test
    public void multiFrameProviderDoneWaitsForFifoThenPlaybackHeadRevealsText() throws Exception {
        CountDownLatch firstWriteStarted = new CountDownLatch(1);
        CountDownLatch releaseWrites = new CountDownLatch(1);
        CountDownLatch writesDrained = new CountDownLatch(1);
        AtomicLong writtenFrames = new AtomicLong();
        List<byte[]> writes = new ArrayList<>();
        MoaAssistantAudioProgressTracker progress = new MoaAssistantAudioProgressTracker();
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onPlaybackStarted();
        MoaPcmPlaybackQueue queue = new MoaPcmPlaybackQueue(1024, pcm -> {
            firstWriteStarted.countDown();
            try {
                if (!releaseWrites.await(2, TimeUnit.SECONDS)) return false;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
            synchronized (writes) {
                writes.add(pcm);
            }
            writtenFrames.addAndGet(MoaAudioPlaybackController.pcmBytesToFrames(pcm.length));
            return true;
        }, listener(writesDrained));

        byte[] first = frame(160, (byte) 1);
        byte[] second = frame(160, (byte) 2);
        admit(progress, queue, segment(0, 0, 5, "hello"), first);
        assertTrue(firstWriteStarted.await(1, TimeUnit.SECONDS));
        long callbackStarted = System.nanoTime();
        admit(progress, queue, segment(1, 5, 11, " world"), second);

        assertEquals("hello world", progress.streamedText());
        assertEquals(0, progress.snapshot(0L).assistantTextChars);
        assertEquals(2, progress.snapshot(40L).assistantTextChars);
        assertFalse(gate.onProviderAudioDone(true));
        queue.finish();
        assertTrue("socket event handling must not wait for device writes",
                TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - callbackStarted) < 100L);
        assertFalse(writesDrained.await(50, TimeUnit.MILLISECONDS));

        releaseWrites.countDown();
        assertTrue(writesDrained.await(2, TimeUnit.SECONDS));
        assertEquals(160L, writtenFrames.get());
        assertEquals(11, progress.snapshot(writtenFrames.get()).assistantTextChars);
        synchronized (writes) {
            assertArrayEquals(first, writes.get(0));
            assertArrayEquals(second, writes.get(1));
        }
    }

    @Test
    public void disabledPlaybackCompletesImmediatelyWithoutMappingReceivedPcm() throws Exception {
        MoaAssistantAudioProgressTracker progress = new MoaAssistantAudioProgressTracker();
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        progress.onAssistantAudioSegment(segment(0, 0, 7, "unheard"));

        // The session does not offer PCM when playback is disabled.
        progress.onAssistantAudioFrameRejected();

        assertTrue(gate.onProviderAudioDone(false));
        assertEquals("", progress.streamedText());
        assertEquals(0L, progress.snapshot(Long.MAX_VALUE).playedPcmBytes);
    }

    @Test
    public void overflowIsCountedAndRejectedFrameDoesNotAdvanceTextLedger() throws Exception {
        CountDownLatch writing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger overflows = new AtomicInteger();
        MoaAssistantAudioProgressTracker progress = new MoaAssistantAudioProgressTracker();
        MoaPcmPlaybackQueue queue = new MoaPcmPlaybackQueue(10, pcm -> {
            writing.countDown();
            try {
                release.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
            return true;
        }, new MoaPcmPlaybackQueue.Listener() {
            @Override public void onDrained(long acceptedBytes) {}
            @Override public void onOverflow(int pendingBytes, int offeredBytes) {
                assertEquals(8, pendingBytes);
                assertEquals(8, offeredBytes);
                overflows.incrementAndGet();
            }
            @Override public void onWriteFailed() {}
        });

        admit(progress, queue, segment(0, 0, 4, "abcd"), frame(8, (byte) 1));
        assertTrue(writing.await(1, TimeUnit.SECONDS));
        admit(progress, queue, segment(1, 4, 8, "efgh"), frame(8, (byte) 2));
        progress.onAssistantAudioSegment(segment(2, 8, 12, "ijkl"));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.OVERFLOW,
                queue.offer(frame(8, (byte) 3)));
        progress.onAssistantAudioFrameRejected();

        assertEquals(1, overflows.get());
        assertEquals("abcdefgh", progress.streamedText());
        assertEquals(8, progress.snapshot(8L).assistantTextChars);
        queue.cancel();
        release.countDown();
    }

    @Test
    public void replacementCancelsOldGenerationAndRetryAcceptsOnlyFreshFrames() throws Exception {
        CountDownLatch oldWriteStarted = new CountDownLatch(1);
        CountDownLatch holdOldWrite = new CountDownLatch(1);
        AtomicInteger oldWrites = new AtomicInteger();
        MoaPcmPlaybackQueue oldGeneration = new MoaPcmPlaybackQueue(128, pcm -> {
            oldWriteStarted.countDown();
            try {
                holdOldWrite.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
            oldWrites.incrementAndGet();
            return true;
        }, listener(new CountDownLatch(1)));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED,
                oldGeneration.offer(frame(16, (byte) 1)));
        assertTrue(oldWriteStarted.await(1, TimeUnit.SECONDS));
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED,
                oldGeneration.offer(frame(16, (byte) 2)));

        // Replacement/retry invalidates the old FIFO before starting a fresh one.
        oldGeneration.cancel();
        assertEquals(MoaPcmPlaybackQueue.OfferResult.CLOSED,
                oldGeneration.offer(frame(16, (byte) 3)));

        CountDownLatch retryDrained = new CountDownLatch(1);
        List<byte[]> retryWrites = new ArrayList<>();
        MoaPcmPlaybackQueue retryGeneration = new MoaPcmPlaybackQueue(128, pcm -> {
            retryWrites.add(pcm);
            return true;
        }, listener(retryDrained));
        byte[] fresh = frame(16, (byte) 4);
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED,
                retryGeneration.offer(fresh));
        retryGeneration.finish();

        holdOldWrite.countDown();
        assertTrue(retryDrained.await(1, TimeUnit.SECONDS));
        assertEquals(0, oldWrites.get());
        assertEquals(1, retryWrites.size());
        assertArrayEquals(fresh, retryWrites.get(0));
    }

    @Test
    public void zeroFrameAudioDoneIsAValidImmediateDrain() throws Exception {
        CountDownLatch drained = new CountDownLatch(1);
        AtomicLong accepted = new AtomicLong(-1L);
        AtomicBoolean deviceCompletion = new AtomicBoolean(false);
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onPlaybackStarted();
        assertFalse(gate.onProviderAudioDone(true));
        MoaPcmPlaybackQueue queue = new MoaPcmPlaybackQueue(128, pcm -> true,
                new MoaPcmPlaybackQueue.Listener() {
                    @Override public void onDrained(long acceptedBytes) {
                        accepted.set(acceptedBytes);
                        deviceCompletion.set(gate.onPlaybackStopped(true));
                        drained.countDown();
                    }
                    @Override public void onOverflow(int pendingBytes, int offeredBytes) {}
                    @Override public void onWriteFailed() {}
                });

        queue.finish();

        assertTrue(drained.await(1, TimeUnit.SECONDS));
        assertEquals(0L, accepted.get());
        assertTrue(deviceCompletion.get());
    }

    private static void admit(MoaAssistantAudioProgressTracker progress,
            MoaPcmPlaybackQueue queue, JSONObject segment, byte[] pcm) {
        progress.onAssistantAudioSegment(segment);
        MoaPcmPlaybackQueue.OfferResult result = queue.offer(pcm);
        assertEquals(MoaPcmPlaybackQueue.OfferResult.ACCEPTED, result);
        progress.onAssistantAudioFrame(pcm);
    }

    private static JSONObject segment(int index, int start, int end, String text) throws Exception {
        return new JSONObject()
                .put("segment_index", index)
                .put("text_start", start)
                .put("text_end", end)
                .put("text", text);
    }

    private static byte[] frame(int bytes, byte value) {
        byte[] frame = new byte[bytes];
        java.util.Arrays.fill(frame, value);
        return frame;
    }

    private static MoaPcmPlaybackQueue.Listener listener(CountDownLatch drained) {
        return new MoaPcmPlaybackQueue.Listener() {
            @Override public void onDrained(long acceptedBytes) { drained.countDown(); }
            @Override public void onOverflow(int pendingBytes, int offeredBytes) {}
            @Override public void onWriteFailed() {}
        };
    }
}

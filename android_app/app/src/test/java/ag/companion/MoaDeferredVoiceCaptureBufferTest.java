package ag.companion;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaDeferredVoiceCaptureBufferTest {
    private static final int PCM_BYTES_PER_40_MS =
            MoaAudioCaptureController.SAMPLE_RATE_HZ * 2 * 40 / 1000;

    @Test
    public void tenSecondAuthorityDelayPreservesEveryPrefixChunkInOrder() {
        MoaDeferredVoiceCaptureBuffer buffer = new MoaDeferredVoiceCaptureBuffer(
                MoaStreamingVoiceSessionController.MAX_PENDING_AUDIO_BYTES,
                MoaStreamingVoiceSessionController.MAX_PENDING_AUDIO_BYTES);
        buffer.beginDeferredCapture();
        List<byte[]> expected = new ArrayList<>();

        for (int index = 0; index < 250; index++) {
            byte[] chunk = new byte[PCM_BYTES_PER_40_MS];
            chunk[0] = (byte) index;
            chunk[chunk.length - 1] = (byte) (index >>> 8);
            expected.add(chunk);
            assertEquals(MoaDeferredVoiceCaptureBuffer.AppendResult.ACCEPTED,
                    buffer.append(chunk));
        }

        assertFalse(buffer.hasOverflowed());
        assertTrue(buffer.byteCount() >= MoaAudioCaptureController.SAMPLE_RATE_HZ * 2 * 10);
        for (byte[] chunk : expected) {
            assertArrayEquals(chunk, buffer.pollFirst());
        }
        assertEquals(null, buffer.pollFirst());
        assertEquals(0, buffer.byteCount());
    }

    @Test
    public void capacityOverflowIsExplicitStickyAndNeverEvictsPrefix() {
        MoaDeferredVoiceCaptureBuffer buffer = new MoaDeferredVoiceCaptureBuffer(8, 8);
        buffer.beginDeferredCapture();
        byte[] prefix = new byte[] {1, 2, 3, 4, 5, 6};

        assertEquals(MoaDeferredVoiceCaptureBuffer.AppendResult.ACCEPTED, buffer.append(prefix));
        assertEquals(MoaDeferredVoiceCaptureBuffer.AppendResult.OVERFLOW,
                buffer.append(new byte[] {7, 8, 9}));
        assertTrue(buffer.hasOverflowed());
        assertTrue(buffer.isFrozen());
        assertEquals(MoaDeferredVoiceCaptureBuffer.AppendResult.FROZEN,
                buffer.append(new byte[] {10}));
        assertArrayEquals(prefix, buffer.pollFirst());
        assertEquals(null, buffer.pollFirst());
    }

    @Test
    public void pendingCommitDeadlineCoversExactDraftAuthorityDeadline() {
        assertTrue(MoaStreamingVoiceSessionController.PENDING_COMMIT_TIMEOUT_MS
                >= MoaStreamingVoiceSessionController.DRAFT_READY_TIMEOUT_MS + 4000);
        assertTrue(MoaStreamingVoiceSessionController.PRE_READY_AUDIO_CAPACITY_MS
                > MoaStreamingVoiceSessionController.PENDING_COMMIT_TIMEOUT_MS);
    }
}

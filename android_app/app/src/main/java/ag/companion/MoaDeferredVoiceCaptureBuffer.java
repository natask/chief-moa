package ag.companion;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Bounded PCM ownership for a gesture-warmed microphone.
 *
 * <p>Before a hold is confirmed this behaves as a small rolling pre-roll. Once
 * promoted, it preserves the complete ordered draft up to an explicit bound.
 * Overflow is sticky and freezes the buffer; callers must fail the draft rather
 * than execute truncated audio.</p>
 */
final class MoaDeferredVoiceCaptureBuffer {
    enum AppendResult {
        ACCEPTED,
        OVERFLOW,
        FROZEN
    }

    private final int rollingMaxBytes;
    private final int deferredMaxBytes;
    private final ArrayDeque<byte[]> chunks = new ArrayDeque<>();
    private int byteCount;
    private boolean deferred;
    private boolean frozen;
    private boolean overflowed;

    MoaDeferredVoiceCaptureBuffer(int rollingMaxBytes, int deferredMaxBytes) {
        if (rollingMaxBytes <= 0 || deferredMaxBytes < rollingMaxBytes) {
            throw new IllegalArgumentException("invalid PCM buffer bounds");
        }
        this.rollingMaxBytes = rollingMaxBytes;
        this.deferredMaxBytes = deferredMaxBytes;
    }

    AppendResult append(byte[] pcm) {
        if (pcm == null || pcm.length == 0) {
            return frozen ? AppendResult.FROZEN : AppendResult.ACCEPTED;
        }
        if (frozen) {
            return AppendResult.FROZEN;
        }
        int limit = deferred ? deferredMaxBytes : rollingMaxBytes;
        if (deferred && pcm.length > limit - byteCount) {
            overflowed = true;
            frozen = true;
            return AppendResult.OVERFLOW;
        }
        chunks.addLast(pcm);
        byteCount += pcm.length;
        while (!deferred && byteCount > limit && !chunks.isEmpty()) {
            byte[] dropped = chunks.removeFirst();
            byteCount = Math.max(0, byteCount - dropped.length);
        }
        return AppendResult.ACCEPTED;
    }

    void beginDeferredCapture() {
        if (frozen) {
            return;
        }
        deferred = true;
        overflowed = false;
    }

    void continueLive() {
        deferred = false;
    }

    void freeze() {
        if (deferred) {
            frozen = true;
        }
    }

    boolean isDeferred() {
        return deferred;
    }

    boolean isFrozen() {
        return frozen;
    }

    boolean hasOverflowed() {
        return overflowed;
    }

    boolean isEmpty() {
        return chunks.isEmpty();
    }

    int byteCount() {
        return byteCount;
    }

    List<byte[]> drainAndReset() {
        List<byte[]> drained = new ArrayList<>(chunks);
        reset();
        return drained;
    }

    void reset() {
        chunks.clear();
        byteCount = 0;
        deferred = false;
        frozen = false;
        overflowed = false;
    }
}

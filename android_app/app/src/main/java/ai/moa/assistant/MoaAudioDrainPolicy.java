package ai.moa.assistant;

/** Pure policy for deciding when streamed PCM may be released after network completion. */
final class MoaAudioDrainPolicy {
    static final long POLL_INTERVAL_MS = 25L;
    private static final long MIN_TIMEOUT_MS = 2_000L;
    private static final long MAX_TIMEOUT_MS = 120_000L;
    private static final long TIMEOUT_MARGIN_MS = 2_000L;

    enum Decision {
        WAIT,
        DRAINED,
        TIMED_OUT
    }

    private MoaAudioDrainPolicy() {
    }

    static Decision decide(long writtenFrames, long playedFrames, long elapsedMs) {
        long written = Math.max(0L, writtenFrames);
        if (written == 0L || playedFrames >= written) {
            return Decision.DRAINED;
        }
        // The deadline is fixed from the initial queued frame count. Recomputing
        // it from a shrinking remainder makes healthy advancing playback cross
        // an ever-shorter deadline and time out just before it drains.
        return Math.max(0L, elapsedMs) >= timeoutMs(written)
                ? Decision.TIMED_OUT
                : Decision.WAIT;
    }

    static long timeoutMs(long writtenFrames) {
        long frames = Math.max(0L, writtenFrames);
        long durationMs;
        if (frames > Long.MAX_VALUE / 1_000L) {
            durationMs = MAX_TIMEOUT_MS;
        } else {
            durationMs = frames * 1_000L / MoaAudioPlaybackController.SAMPLE_RATE_HZ;
        }
        long bounded = durationMs > Long.MAX_VALUE - TIMEOUT_MARGIN_MS
                ? MAX_TIMEOUT_MS
                : durationMs + TIMEOUT_MARGIN_MS;
        return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, bounded));
    }
}

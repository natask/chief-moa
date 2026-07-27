package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaAudioDrainPolicyTest {
    @Test
    public void waitsUntilPlaybackHeadConsumesEveryWrittenFrame() {
        assertEquals(MoaAudioDrainPolicy.Decision.WAIT,
                MoaAudioDrainPolicy.decide(16_000L, 15_999L, 500L));
        assertEquals(MoaAudioDrainPolicy.Decision.DRAINED,
                MoaAudioDrainPolicy.decide(16_000L, 16_000L, 500L));
    }

    @Test
    public void emptyPlaybackIsAlreadyDrained() {
        assertEquals(MoaAudioDrainPolicy.Decision.DRAINED,
                MoaAudioDrainPolicy.decide(0L, -1L, 0L));
    }

    @Test
    public void unreadableOrStalledHeadTimesOutAtBoundedDuration() {
        long timeout = MoaAudioDrainPolicy.timeoutMs(32_000L);
        assertEquals(4_000L, timeout);
        assertEquals(MoaAudioDrainPolicy.Decision.WAIT,
                MoaAudioDrainPolicy.decide(32_000L, -1L, timeout - 1L));
        assertEquals(MoaAudioDrainPolicy.Decision.TIMED_OUT,
                MoaAudioDrainPolicy.decide(32_000L, -1L, timeout));
    }

    @Test
    public void advancingPlaybackKeepsTheInitialDeadline() {
        long initialFrames = 32_000L;
        assertEquals(MoaAudioDrainPolicy.Decision.WAIT,
                MoaAudioDrainPolicy.decide(initialFrames, 31_000L, 3_500L));
        assertEquals(MoaAudioDrainPolicy.Decision.DRAINED,
                MoaAudioDrainPolicy.decide(initialFrames, initialFrames, 3_999L));
        assertEquals(MoaAudioDrainPolicy.Decision.TIMED_OUT,
                MoaAudioDrainPolicy.decide(initialFrames, 31_999L, 4_000L));
    }

    @Test
    public void timeoutIsBoundedForTinyAndHostileFrameCounts() {
        assertEquals(2_000L, MoaAudioDrainPolicy.timeoutMs(1L));
        assertEquals(120_000L, MoaAudioDrainPolicy.timeoutMs(Long.MAX_VALUE));
    }
}

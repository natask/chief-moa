package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaVoiceEndpointerTest {
    private static final long FRAME_MS = 20L;

    @Test
    public void steadyNoiseProducesNoFalseStartOrCommitAndCancelsOnce() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        int falseStarts = 0;
        int commits = 0;
        int cancellations = 0;

        for (long now = 1L; now <= 13_001L; now += FRAME_MS) {
            endpointer.observe(pcm(140), now);
            if (endpointer.heardSpeech()) falseStarts += 1;
            MoaVoiceEndpointer.Decision decision = endpointer.evaluate(now);
            if (decision == MoaVoiceEndpointer.Decision.COMMIT) commits += 1;
            if (decision == MoaVoiceEndpointer.Decision.CANCEL_NO_SPEECH) cancellations += 1;
        }

        assertEquals("false starts", 0, falseStarts);
        assertEquals("false commits", 0, commits);
        assertEquals("no-speech cancellations", 1, cancellations);
        System.out.println("voice_endpointer steady_noise false_starts=0 false_commits=0 cancellations=1");
    }

    @Test
    public void quietSpeechAboveAdaptiveFloorStartsAfterConsecutiveFrames() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 20, 120);
        int learnedFloor = endpointer.noiseFloor();

        endpointer.observe(pcm(360), now);
        endpointer.observe(pcm(360), now + FRAME_MS);
        assertFalse(endpointer.heardSpeech());
        endpointer.observe(pcm(360), now + 2L * FRAME_MS);

        assertTrue(endpointer.heardSpeech());
        assertTrue("startup floor learned", learnedFloor >= 100 && learnedFloor < 160);
        System.out.println("voice_endpointer quiet_speech learned_floor=" + learnedFloor + " start_frames=3");
    }

    @Test
    public void briefDipProducesZeroFalseCutsAndSustainedSilenceCommitsOnceAt700Ms() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 10, 100);
        now = feed(endpointer, now, 8, 600);
        long firstSpeechTail = endpointer.lastVoiceActivityAtMs();
        int falseCuts = 0;

        for (long dip = FRAME_MS; dip <= 500L; dip += FRAME_MS) {
            endpointer.observe(pcm(0), firstSpeechTail + dip);
            if (endpointer.evaluate(firstSpeechTail + dip) == MoaVoiceEndpointer.Decision.COMMIT) falseCuts += 1;
        }
        long resumedAt = firstSpeechTail + 520L;
        endpointer.observe(pcm(600), resumedAt);
        assertEquals("false cuts during brief dip", 0, falseCuts);

        int commits = 0;
        long committedAt = -1L;
        for (long silence = FRAME_MS; silence <= 1_000L; silence += FRAME_MS) {
            long tick = resumedAt + silence;
            endpointer.observe(pcm(0), tick);
            if (endpointer.evaluate(tick) == MoaVoiceEndpointer.Decision.COMMIT) {
                commits += 1;
                committedAt = tick;
            }
        }

        long endpointDelay = committedAt - resumedAt;
        assertEquals("commits", 1, commits);
        assertEquals("endpoint delay", MoaVoiceEndpointer.ENDPOINT_SILENCE_MS, endpointDelay);
        System.out.println("voice_endpointer endpoint_delay_ms=" + endpointDelay + " false_cuts=0 commits=1");
    }

    @Test
    public void resetDoesNotCarrySpeechOrTerminalStateIntoTheNextTurn() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 6, 700);
        assertTrue(endpointer.heardSpeech());
        assertEquals(MoaVoiceEndpointer.Decision.COMMIT,
                endpointer.evaluate(endpointer.lastVoiceActivityAtMs() + MoaVoiceEndpointer.ENDPOINT_SILENCE_MS));

        endpointer.reset(5_000L);
        assertFalse(endpointer.heardSpeech());
        assertEquals(MoaVoiceEndpointer.Decision.NONE, endpointer.evaluate(5_700L));
        now = feed(endpointer, 5_000L, 20, 120);
        assertFalse(endpointer.heardSpeech());
        assertEquals(MoaVoiceEndpointer.Decision.CANCEL_NO_SPEECH,
                endpointer.evaluate(5_000L + MoaVoiceEndpointer.NO_SPEECH_TIMEOUT_MS));
        assertTrue(now > 5_000L);
        System.out.println("voice_endpointer reset_isolation=true next_turn_cancellations=1");
    }

    private static MoaVoiceEndpointer startedAt(long nowMs) {
        MoaVoiceEndpointer endpointer = new MoaVoiceEndpointer();
        endpointer.reset(nowMs);
        return endpointer;
    }

    private static long feed(MoaVoiceEndpointer endpointer, long startMs, int frames, int level) {
        long now = startMs;
        for (int frame = 0; frame < frames; frame += 1) {
            endpointer.observe(pcm(level), now);
            endpointer.evaluate(now);
            now += FRAME_MS;
        }
        return now;
    }

    private static byte[] pcm(int level) {
        int bounded = Math.max(0, Math.min(Short.MAX_VALUE, level));
        byte[] pcm = new byte[320];
        for (int index = 0; index < pcm.length; index += 2) {
            int sample = (index / 2) % 2 == 0 ? bounded : -bounded;
            pcm[index] = (byte) (sample & 0xff);
            pcm[index + 1] = (byte) ((sample >> 8) & 0xff);
        }
        return pcm;
    }
}

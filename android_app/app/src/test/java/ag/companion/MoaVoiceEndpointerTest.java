package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaVoiceEndpointerTest {
    private static final long FRAME_MS = 20L;

    @Test
    public void steady250CalibratesWithoutFalseStartOrCommitAndCancelsOnce() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        int falseStarts = 0;
        int commits = 0;
        int cancellations = 0;

        for (long now = 1L; now <= 13_001L; now += FRAME_MS) {
            endpointer.observe(pcm(250), now);
            if (endpointer.heardSpeech()) falseStarts += 1;
            MoaVoiceEndpointer.Decision decision = endpointer.evaluate(now);
            if (decision == MoaVoiceEndpointer.Decision.COMMIT) commits += 1;
            if (decision == MoaVoiceEndpointer.Decision.CANCEL_NO_SPEECH) cancellations += 1;
        }

        assertEquals("false starts", 0, falseStarts);
        assertEquals("false commits", 0, commits);
        assertEquals("no-speech cancellations", 1, cancellations);
        assertEquals("learned steady floor", 250, endpointer.noiseFloor());
        System.out.println("voice_endpointer steady_250 false_starts=0 false_commits=0 cancellations=1 floor=250");
    }

    @Test
    public void quietSpeechAboveAdaptiveFloorStartsAfterConsecutiveFrames() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 6, 40L, 120);
        int learnedFloor = endpointer.noiseFloor();

        endpointer.observe(pcm(360, 40L), now);
        endpointer.observe(pcm(360, 40L), now + 40L);
        assertFalse(endpointer.heardSpeech());
        endpointer.observe(pcm(360, 40L), now + 80L);

        assertTrue(endpointer.heardSpeech());
        assertEquals("startup floor learned", 120, learnedFloor);
        System.out.println("voice_endpointer quiet_speech learned_floor=120 calibration_ms=240 admission_ms=120");
    }

    @Test
    public void immediateLegacyStrengthSpeechAdmitsWithoutContaminatingCalibration() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long admittedAfter = -1L;
        for (long elapsed = 40L; elapsed <= 120L; elapsed += 40L) {
            endpointer.observe(pcm(600, 40L), elapsed);
            if (endpointer.heardSpeech()) admittedAfter = elapsed;
        }

        assertEquals("immediate admission duration", 120L, admittedAfter);
        assertFalse("strong speech is not ambient calibration", endpointer.calibrated());
        assertEquals("initial floor remains clean", 64, endpointer.noiseFloor());
        MoaVoiceEndpointer boundary = startedAt(1L);
        feed(boundary, 1L, 3, 40L, 450);
        assertTrue("legacy boundary remains hard-strong", boundary.heardSpeech());
        System.out.println("voice_endpointer immediate_frame1_level=600 admission_ms=120 calibration_contamination=0 hard_boundary=450");
    }

    @Test
    public void productionAndIrregularPartialReadsAdmitAfterTheSameAudioDuration() {
        long productionAdmission = admissionDuration(new long[]{40L, 40L, 40L});
        long irregularAdmission = admissionDuration(new long[]{10L, 30L, 15L, 25L, 40L});

        assertEquals(MoaVoiceEndpointer.START_ADMISSION_MS, productionAdmission);
        assertEquals(productionAdmission, irregularAdmission);
        System.out.println("voice_endpointer production_frame_bytes=1280 admission_ms="
                + productionAdmission + " irregular_admission_ms=" + irregularAdmission);
    }

    @Test
    public void briefDipProducesZeroFalseCutsAndSustainedSilenceCommitsOnceAt700Ms() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 6, 40L, 100);
        now = feed(endpointer, now, 3, 40L, 600);
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
    public void adaptive250PlateauAfterHardSpeechHasBoundedContinuation() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 6, 40L, 100);
        now = feed(endpointer, now, 3, 40L, 600);
        long lastStrongAt = endpointer.lastVoiceActivityAtMs();
        int commits = 0;
        long committedAt = -1L;

        for (long plateau = 40L; plateau <= 1_200L; plateau += 40L) {
            long tick = lastStrongAt + plateau;
            endpointer.observe(pcm(250, 40L), tick);
            if (endpointer.evaluate(tick) == MoaVoiceEndpointer.Decision.COMMIT) {
                commits += 1;
                committedAt = tick;
            }
        }

        long boundedDelay = committedAt - lastStrongAt;
        assertEquals("one bounded commit", 1, commits);
        assertTrue("weak continuation bounded", boundedDelay <= MoaVoiceEndpointer.ENDPOINT_SILENCE_MS
                + MoaVoiceEndpointer.WEAK_CONTINUATION_LIMIT_MS);
        System.out.println("voice_endpointer hard600_to_adaptive250 commits=1 bounded_endpoint_ms=" + boundedDelay);
    }

    @Test
    public void variableQuietSpeechRemainsUsableBeyondSixSeconds() {
        MoaVoiceEndpointer endpointer = calibratedAt(100);
        long now = 241L;
        now = feed(endpointer, now, 3, 40L, 280);
        assertTrue(endpointer.heardSpeech());
        int falseCuts = 0;

        for (int frame = 0; frame < 175; frame += 1) {
            int level = frame % 5 == 4 ? 100 : (frame % 2 == 0 ? 240 : 330);
            endpointer.observe(pcm(level, 40L), now);
            if (endpointer.evaluate(now) == MoaVoiceEndpointer.Decision.COMMIT) falseCuts += 1;
            now += 40L;
        }

        assertEquals("variable quiet speech false cuts", 0, falseCuts);
        assertTrue("quiet trace stays active", endpointer.heardSpeech());
        System.out.println("voice_endpointer variable_quiet_duration_ms=7000 false_cuts=0");
    }

    @Test
    public void constantAdaptiveBandHasAnExplicitMaximumInsteadOfInfiniteRefresh() {
        MoaVoiceEndpointer endpointer = calibratedAt(100);
        long now = feed(endpointer, 241L, 3, 40L, 250);
        long admittedAt = endpointer.lastVoiceActivityAtMs();
        int commits = 0;
        long committedAt = -1L;

        for (int frame = 0; frame < 140; frame += 1) {
            endpointer.observe(pcm(250, 40L), now);
            if (endpointer.evaluate(now) == MoaVoiceEndpointer.Decision.COMMIT) {
                commits += 1;
                committedAt = now;
            }
            now += 40L;
        }

        long boundedDelay = committedAt - admittedAt;
        assertEquals("constant adaptive commit", 1, commits);
        assertTrue("stationary adaptive maximum", boundedDelay <= MoaVoiceEndpointer.ADAPTIVE_STATIONARY_LIMIT_MS
                + MoaVoiceEndpointer.ENDPOINT_SILENCE_MS + 40L);
        System.out.println("voice_endpointer constant_adaptive250 commits=1 bounded_endpoint_ms=" + boundedDelay);
    }

    @Test
    public void coldAdaptiveRangeIsCalibratedAsPossibleAmbient() {
        for (int level : new int[]{220, 300, 449}) {
            MoaVoiceEndpointer endpointer = startedAt(1L);
            feed(endpointer, 1L, 30, 40L, level);
            assertTrue("calibrated " + level, endpointer.calibrated());
            assertFalse("cold ambient did not admit " + level, endpointer.heardSpeech());
            assertEquals("learned floor " + level, level, endpointer.noiseFloor());
        }
        System.out.println("voice_endpointer cold_ambient_sweep=220,300,449 false_starts=0");
    }

    @Test
    public void calibrationBackgroundBreaksSeparatedHardStrongCandidates() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        endpointer.observe(pcm(600, 80L), 1L);
        feed(endpointer, 81L, 6, 40L, 250);
        endpointer.observe(pcm(600, 40L), 321L);

        assertFalse("separated hard evidence is not 120ms continuous", endpointer.heardSpeech());
        endpointer.observe(pcm(600, 80L), 361L);
        assertTrue("fresh continuous hard evidence admits", endpointer.heardSpeech());
        System.out.println("voice_endpointer separated_hard_candidate_reset=true fresh_admission_ms=120");
    }

    @Test
    public void exactStartAndContinueThresholdsHaveFailClosedBoundaries() {
        MoaVoiceEndpointer belowStart = calibratedAt(100);
        int start = belowStart.startThreshold();
        feed(belowStart, 241L, 4, 40L, start - 1);
        assertFalse("below start", belowStart.heardSpeech());

        MoaVoiceEndpointer atStart = calibratedAt(100);
        feed(atStart, 241L, 3, 40L, start);
        assertTrue("at start", atStart.heardSpeech());
        long strongAt = atStart.lastVoiceActivityAtMs();
        int continuation = atStart.continueThreshold();
        atStart.observe(pcm(continuation - 1, 40L), strongAt + 40L);
        assertEquals("below continue does not refresh", strongAt, atStart.lastVoiceActivityAtMs());
        atStart.observe(pcm(continuation, 40L), strongAt + 80L);
        assertEquals("at continue bridges", strongAt + 80L, atStart.lastVoiceActivityAtMs());
        System.out.println("voice_endpointer threshold_sweep start=" + start + " continue=" + continuation);
    }

    @Test
    public void callbackStraddlingCalibrationCountsOnlyItsPostBoundarySamplesForAdmission() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 5, 40L, 100);
        endpointer.observe(pcm(360, 80L), now);
        assertTrue(endpointer.calibrated());
        assertFalse("only 40ms after boundary counts", endpointer.heardSpeech());
        endpointer.observe(pcm(360, 40L), now + 80L);
        assertFalse("80ms admission evidence", endpointer.heardSpeech());
        endpointer.observe(pcm(360, 40L), now + 120L);
        assertTrue("120ms admission evidence", endpointer.heardSpeech());
        System.out.println("voice_endpointer straddle_pre_ms=40 straddle_post_ms=40 total_admission_ms=120");
    }

    @Test
    public void resetDoesNotCarrySpeechOrTerminalStateIntoTheNextTurn() {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        long now = feed(endpointer, 1L, 6, 40L, 100);
        now = feed(endpointer, now, 3, 40L, 700);
        assertTrue(endpointer.heardSpeech());
        assertEquals(MoaVoiceEndpointer.Decision.COMMIT,
                endpointer.evaluate(endpointer.lastVoiceActivityAtMs() + MoaVoiceEndpointer.ENDPOINT_SILENCE_MS));

        endpointer.reset(5_000L);
        assertFalse(endpointer.heardSpeech());
        assertEquals(MoaVoiceEndpointer.Decision.NONE, endpointer.evaluate(5_700L));
        now = feed(endpointer, 5_000L, 6, 40L, 120);
        assertFalse(endpointer.heardSpeech());
        assertEquals(MoaVoiceEndpointer.Decision.CANCEL_NO_SPEECH,
                endpointer.evaluate(5_000L + MoaVoiceEndpointer.NO_SPEECH_TIMEOUT_MS));
        assertTrue(now > 5_000L);
        System.out.println("voice_endpointer reset_isolation=true next_turn_cancellations=1");
    }

    private static long admissionDuration(long[] frameDurationsMs) {
        MoaVoiceEndpointer endpointer = calibratedAt(100);
        long now = 241L;
        long total = 0L;
        for (long duration : frameDurationsMs) {
            total += duration;
            now += duration;
            endpointer.observe(pcm(500, duration), now);
            if (endpointer.heardSpeech()) return total;
        }
        return -1L;
    }

    private static MoaVoiceEndpointer calibratedAt(int floor) {
        MoaVoiceEndpointer endpointer = startedAt(1L);
        feed(endpointer, 1L, 6, 40L, floor);
        assertTrue(endpointer.calibrated());
        return endpointer;
    }

    private static MoaVoiceEndpointer startedAt(long nowMs) {
        MoaVoiceEndpointer endpointer = new MoaVoiceEndpointer();
        endpointer.reset(nowMs);
        return endpointer;
    }

    private static long feed(MoaVoiceEndpointer endpointer, long startMs, int frames,
            long frameDurationMs, int level) {
        long now = startMs;
        for (int frame = 0; frame < frames; frame += 1) {
            endpointer.observe(pcm(level, frameDurationMs), now);
            endpointer.evaluate(now);
            now += frameDurationMs;
        }
        return now;
    }

    private static byte[] pcm(int level) {
        return pcm(level, FRAME_MS);
    }

    private static byte[] pcm(int level, long durationMs) {
        int bounded = Math.max(0, Math.min(Short.MAX_VALUE, level));
        int samples = (int) (16_000L * durationMs / 1000L);
        byte[] pcm = new byte[samples * 2];
        for (int index = 0; index < pcm.length; index += 2) {
            int sample = (index / 2) % 2 == 0 ? bounded : -bounded;
            pcm[index] = (byte) (sample & 0xff);
            pcm[index + 1] = (byte) ((sample >> 8) & 0xff);
        }
        return pcm;
    }
}

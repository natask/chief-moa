package ag.companion;

/**
 * Deterministic PCM16 endpointer for hands-free turns.
 *
 * The detector spends a short, fail-closed interval learning the startup floor,
 * then requires a duration of speech rather than a number of callbacks. This
 * keeps partial AudioRecord reads from changing admission. Once speech starts,
 * a lower continuation band may bridge a short soft passage but cannot let a
 * sustained background plateau hold the turn forever.
 */
final class MoaVoiceEndpointer {
    static final long ENDPOINT_SILENCE_MS = 700L;
    static final long MIN_RECORDING_MS = 650L;
    static final long NO_SPEECH_TIMEOUT_MS = 12_000L;
    static final long STUCK_VAD_BACKSTOP_MS = 1_800_000L;

    static final long CALIBRATION_MS = 240L;
    static final long START_ADMISSION_MS = 120L;
    static final long WEAK_CONTINUATION_LIMIT_MS = 200L;
    static final long ADAPTIVE_STATIONARY_LIMIT_MS = 400L;
    static final long ADAPTIVE_ONLY_LIMIT_MS = 8_000L;

    private static final int SAMPLE_RATE_HZ = 16_000;
    private static final int PCM_BYTES_PER_SAMPLE = 2;
    private static final int CALIBRATION_SAMPLES = samplesForMs(CALIBRATION_MS);
    private static final int START_ADMISSION_SAMPLES = samplesForMs(START_ADMISSION_MS);
    private static final int INITIAL_NOISE_FLOOR = 64;
    private static final int HARD_STRONG_LEVEL = 450;
    private static final int MIN_START_LEVEL = 220;
    private static final int MIN_CONTINUE_LEVEL = 140;
    private static final int START_MARGIN = 100;
    private static final int CONTINUE_MARGIN = 70;
    private static final int ADAPTIVE_VARIATION_LEVEL = 24;

    enum Decision {
        NONE,
        COMMIT,
        CANCEL_NO_SPEECH
    }

    private long recordingStartedAtMs;
    private long lastVoiceActivityAtMs;
    private long adaptiveRefreshUntilMs;
    private long adaptiveAbsoluteUntilMs;
    private int lastAdaptiveLevel;
    private boolean adaptiveOnlySpeech;
    private int noiseFloor = INITIAL_NOISE_FLOOR;
    private int calibrationSamples;
    private long calibrationLevelSampleTotal;
    private int consecutiveStartSamples;
    private boolean candidateContainsHardStrong;
    private boolean heardSpeech;
    private boolean terminalDecisionEmitted;

    void reset(long nowMs) {
        recordingStartedAtMs = Math.max(0L, nowMs);
        lastVoiceActivityAtMs = 0L;
        adaptiveRefreshUntilMs = 0L;
        adaptiveAbsoluteUntilMs = 0L;
        lastAdaptiveLevel = 0;
        adaptiveOnlySpeech = false;
        noiseFloor = INITIAL_NOISE_FLOOR;
        calibrationSamples = 0;
        calibrationLevelSampleTotal = 0L;
        consecutiveStartSamples = 0;
        candidateContainsHardStrong = false;
        heardSpeech = false;
        terminalDecisionEmitted = false;
    }

    boolean observe(byte[] pcm, long nowMs) {
        if (terminalDecisionEmitted || recordingStartedAtMs <= 0L || pcm == null || pcm.length < 2) {
            return false;
        }
        int availableSamples = pcm.length / PCM_BYTES_PER_SAMPLE;
        int level = meanAbsolutePcm16(pcm);
        // Preserve the old detector's >=450 signal as hard evidence. It may
        // admit immediately and is never folded into the ambient estimate.
        // Energy from 220..449 remains ambiguous and calibrates fail-closed.
        if (calibrationSamples < CALIBRATION_SAMPLES) {
            int calibrating = Math.min(availableSamples, CALIBRATION_SAMPLES - calibrationSamples);
            int calibrationLevel = meanAbsolutePcm16(pcm, 0, calibrating);
            if (calibrationLevel >= HARD_STRONG_LEVEL) {
                return observeEvidence(level, availableSamples, nowMs);
            }
            // Calibration/background breaks a hard-strong candidate. Otherwise
            // separated loud pulses could accumulate as if they were continuous.
            consecutiveStartSamples = 0;
            candidateContainsHardStrong = false;
            calibrationLevelSampleTotal += (long) calibrationLevel * calibrating;
            calibrationSamples += calibrating;
            availableSamples -= calibrating;
            if (calibrationSamples >= CALIBRATION_SAMPLES) {
                noiseFloor = (int) Math.max(0L, calibrationLevelSampleTotal / calibrationSamples);
            }
            if (availableSamples <= 0) return false;
            level = meanAbsolutePcm16(pcm, calibrating, availableSamples);
        }
        return observeEvidence(level, availableSamples, nowMs);
    }

    private boolean observeEvidence(int level, int availableSamples, long nowMs) {
        boolean hardStrong = level >= HARD_STRONG_LEVEL;
        if (heardSpeech) {
            if (hardStrong) {
                long hardStrongAtMs = Math.max(recordingStartedAtMs, nowMs);
                adaptiveRefreshUntilMs = hardStrongAtMs + WEAK_CONTINUATION_LIMIT_MS;
                adaptiveAbsoluteUntilMs = 0L;
                adaptiveOnlySpeech = false;
                lastVoiceActivityAtMs = hardStrongAtMs;
                return true;
            }
            if (level >= continueThreshold()) {
                if (adaptiveOnlySpeech) {
                    if (Math.abs(level - lastAdaptiveLevel) >= ADAPTIVE_VARIATION_LEVEL) {
                        adaptiveRefreshUntilMs = Math.min(
                                nowMs + ADAPTIVE_STATIONARY_LIMIT_MS,
                                adaptiveAbsoluteUntilMs);
                    }
                    lastAdaptiveLevel = level;
                }
            }
            if (level >= continueThreshold()
                    && nowMs < adaptiveRefreshUntilMs
                    && (!adaptiveOnlySpeech || nowMs < adaptiveAbsoluteUntilMs)) {
                lastVoiceActivityAtMs = Math.max(recordingStartedAtMs, nowMs);
                return true;
            }
            return false;
        }

        int admissionLevel = hardStrong
                ? HARD_STRONG_LEVEL
                : (calibrated() ? startThreshold() : HARD_STRONG_LEVEL);
        if (level >= admissionLevel) {
            consecutiveStartSamples += availableSamples;
            candidateContainsHardStrong |= hardStrong;
            if (consecutiveStartSamples >= START_ADMISSION_SAMPLES) {
                heardSpeech = true;
                lastVoiceActivityAtMs = Math.max(recordingStartedAtMs, nowMs);
                if (candidateContainsHardStrong) {
                    adaptiveRefreshUntilMs = lastVoiceActivityAtMs + WEAK_CONTINUATION_LIMIT_MS;
                    adaptiveAbsoluteUntilMs = 0L;
                    adaptiveOnlySpeech = false;
                } else {
                    // Energy-only input cannot distinguish steady quiet speech
                    // from a new background plateau. Variable speech may keep
                    // refreshing; stationary energy expires unless a hard-strong
                    // frame arrives.
                    adaptiveOnlySpeech = true;
                    lastAdaptiveLevel = level;
                    adaptiveAbsoluteUntilMs = lastVoiceActivityAtMs + ADAPTIVE_ONLY_LIMIT_MS;
                    adaptiveRefreshUntilMs = lastVoiceActivityAtMs + ADAPTIVE_STATIONARY_LIMIT_MS;
                }
                return true;
            }
            return false;
        }

        consecutiveStartSamples = 0;
        candidateContainsHardStrong = false;
        return false;
    }

    Decision evaluate(long nowMs) {
        if (terminalDecisionEmitted || recordingStartedAtMs <= 0L) {
            return Decision.NONE;
        }
        long ageMs = Math.max(0L, nowMs - recordingStartedAtMs);
        if (!heardSpeech) {
            if (ageMs >= NO_SPEECH_TIMEOUT_MS) {
                terminalDecisionEmitted = true;
                return Decision.CANCEL_NO_SPEECH;
            }
            return Decision.NONE;
        }
        boolean silenceReached = ageMs >= MIN_RECORDING_MS
                && nowMs - lastVoiceActivityAtMs >= ENDPOINT_SILENCE_MS;
        if (silenceReached || ageMs >= STUCK_VAD_BACKSTOP_MS) {
            terminalDecisionEmitted = true;
            return Decision.COMMIT;
        }
        return Decision.NONE;
    }

    boolean heardSpeech() {
        return heardSpeech;
    }

    long lastVoiceActivityAtMs() {
        return lastVoiceActivityAtMs;
    }

    int noiseFloor() {
        return noiseFloor;
    }

    boolean calibrated() {
        return calibrationSamples >= CALIBRATION_SAMPLES;
    }

    int startThreshold() {
        return Math.max(MIN_START_LEVEL, noiseFloor + Math.max(START_MARGIN, noiseFloor * 3 / 4));
    }

    int continueThreshold() {
        return Math.max(MIN_CONTINUE_LEVEL, noiseFloor + Math.max(CONTINUE_MARGIN, noiseFloor / 2));
    }

    private static int samplesForMs(long durationMs) {
        return (int) (SAMPLE_RATE_HZ * durationMs / 1000L);
    }

    static int meanAbsolutePcm16(byte[] pcm) {
        return meanAbsolutePcm16(pcm, 0, pcm == null ? 0 : pcm.length / PCM_BYTES_PER_SAMPLE);
    }

    private static int meanAbsolutePcm16(byte[] pcm, int startSample, int sampleCount) {
        if (pcm == null || startSample < 0 || sampleCount <= 0) {
            return 0;
        }
        long total = 0L;
        int samples = 0;
        int startByte = Math.min(pcm.length, startSample * PCM_BYTES_PER_SAMPLE);
        int endByte = Math.min(pcm.length, startByte + sampleCount * PCM_BYTES_PER_SAMPLE);
        for (int i = startByte; i + 1 < endByte; i += PCM_BYTES_PER_SAMPLE) {
            int sample = (pcm[i + 1] << 8) | (pcm[i] & 0xff);
            total += Math.abs((long) sample);
            samples += 1;
        }
        return samples == 0 ? 0 : (int) Math.min(Integer.MAX_VALUE, total / samples);
    }
}

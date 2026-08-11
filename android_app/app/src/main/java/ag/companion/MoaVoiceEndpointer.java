package ag.companion;

/**
 * Deterministic PCM16 endpointer for hands-free turns.
 *
 * The detector learns the quiet startup floor, requires several consecutive
 * speech frames to open a turn, and uses a lower continuation threshold once
 * speech is active. Time is supplied by the caller so policy tests need no
 * sleeps and lifecycle resets cannot inherit evidence from a prior turn.
 */
final class MoaVoiceEndpointer {
    static final long ENDPOINT_SILENCE_MS = 700L;
    static final long MIN_RECORDING_MS = 650L;
    static final long NO_SPEECH_TIMEOUT_MS = 12_000L;
    static final long STUCK_VAD_BACKSTOP_MS = 1_800_000L;

    private static final int INITIAL_NOISE_FLOOR = 64;
    private static final int MIN_START_LEVEL = 220;
    private static final int MIN_CONTINUE_LEVEL = 140;
    private static final int START_MARGIN = 100;
    private static final int CONTINUE_MARGIN = 70;
    private static final int REQUIRED_START_FRAMES = 3;
    private static final int NOISE_EMA_OLD_WEIGHT = 7;
    private static final int NOISE_EMA_TOTAL_WEIGHT = 8;

    enum Decision {
        NONE,
        COMMIT,
        CANCEL_NO_SPEECH
    }

    private long recordingStartedAtMs;
    private long lastVoiceActivityAtMs;
    private int noiseFloor = INITIAL_NOISE_FLOOR;
    private int consecutiveStartFrames;
    private boolean heardSpeech;
    private boolean terminalDecisionEmitted;

    void reset(long nowMs) {
        recordingStartedAtMs = Math.max(0L, nowMs);
        lastVoiceActivityAtMs = 0L;
        noiseFloor = INITIAL_NOISE_FLOOR;
        consecutiveStartFrames = 0;
        heardSpeech = false;
        terminalDecisionEmitted = false;
    }

    boolean observe(byte[] pcm, long nowMs) {
        if (terminalDecisionEmitted || recordingStartedAtMs <= 0L || pcm == null || pcm.length < 2) {
            return false;
        }
        int level = meanAbsolutePcm16(pcm);
        if (heardSpeech) {
            if (level >= continueThreshold()) {
                lastVoiceActivityAtMs = Math.max(recordingStartedAtMs, nowMs);
                return true;
            }
            return false;
        }

        if (level >= startThreshold()) {
            consecutiveStartFrames += 1;
            if (consecutiveStartFrames >= REQUIRED_START_FRAMES) {
                heardSpeech = true;
                lastVoiceActivityAtMs = Math.max(recordingStartedAtMs, nowMs);
                return true;
            }
            return false;
        }

        consecutiveStartFrames = 0;
        noiseFloor = ((noiseFloor * NOISE_EMA_OLD_WEIGHT) + level) / NOISE_EMA_TOTAL_WEIGHT;
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

    private int startThreshold() {
        return Math.max(MIN_START_LEVEL, noiseFloor + Math.max(START_MARGIN, noiseFloor * 3 / 4));
    }

    private int continueThreshold() {
        return Math.max(MIN_CONTINUE_LEVEL, noiseFloor + Math.max(CONTINUE_MARGIN, noiseFloor / 2));
    }

    static int meanAbsolutePcm16(byte[] pcm) {
        if (pcm == null) {
            return 0;
        }
        long total = 0L;
        int samples = 0;
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            int sample = (pcm[i + 1] << 8) | (pcm[i] & 0xff);
            total += Math.abs((long) sample);
            samples += 1;
        }
        return samples == 0 ? 0 : (int) Math.min(Integer.MAX_VALUE, total / samples);
    }
}

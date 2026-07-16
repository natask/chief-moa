package ai.moa.assistant;

final class MoaVoiceEndpointingPolicy {
    static final long MIN_RECORDING_MS = 650;
    static final long SILENCE_AFTER_SPEECH_MS = 1200;

    private MoaVoiceEndpointingPolicy() {
    }

    static boolean shouldCommit(long recordingAgeMs, long silenceAgeMs, boolean heardSpeech) {
        return heardSpeech
                && recordingAgeMs >= MIN_RECORDING_MS
                && silenceAgeMs >= SILENCE_AFTER_SPEECH_MS;
    }
}

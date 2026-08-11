package ag.companion;

import java.util.function.Consumer;

final class MoaTurnTakingPolicy {
    static final String RESPONSIVE = "responsive";
    static final String PATIENT = "patient";
    static final String STRICT = "strict";
    static final long MIN_RECORDING_MS = 650;
    static final long NO_SPEECH_TIMEOUT_MS = 12_000;
    static final long STUCK_VAD_BACKSTOP_MS = 1_800_000;
    static final int VOICE_ACTIVITY_THRESHOLD = 450;
    static final String STRICT_REFUSAL_NOTICE =
            "Strict turn-taking is on. Wait for Ag to finish or tap Stop.";

    static final class CapturePlan {
        final boolean allowed;
        final boolean teardownPriorTurn;
        final boolean discardWarmMic;
        final boolean cancelPushToTalkRelease;
        final String reason;

        private CapturePlan(
                boolean allowed,
                boolean teardownPriorTurn,
                boolean discardWarmMic,
                boolean cancelPushToTalkRelease,
                String reason
        ) {
            this.allowed = allowed;
            this.teardownPriorTurn = teardownPriorTurn;
            this.discardWarmMic = discardWarmMic;
            this.cancelPushToTalkRelease = cancelPushToTalkRelease;
            this.reason = reason;
        }
    }

    static final class CaptureCoordinator {
        private final Runnable clearAssistantAudioPlaying;
        private final Runnable teardownPriorTurn;
        private final Runnable discardWarmMic;
        private final Runnable cancelPushToTalkRelease;
        private final Consumer<String> logRefusal;
        private final Consumer<String> toastRefusal;
        private final Consumer<String> announceRefusal;

        CaptureCoordinator(
                Runnable clearAssistantAudioPlaying,
                Runnable teardownPriorTurn,
                Runnable discardWarmMic,
                Runnable cancelPushToTalkRelease,
                Consumer<String> logRefusal,
                Consumer<String> toastRefusal,
                Consumer<String> announceRefusal
        ) {
            this.clearAssistantAudioPlaying = clearAssistantAudioPlaying;
            this.teardownPriorTurn = teardownPriorTurn;
            this.discardWarmMic = discardWarmMic;
            this.cancelPushToTalkRelease = cancelPushToTalkRelease;
            this.logRefusal = logRefusal;
            this.toastRefusal = toastRefusal;
            this.announceRefusal = announceRefusal;
        }

        boolean admit(String mode, boolean assistantAudioPlaying, boolean pushToTalk) {
            CapturePlan plan = capturePlan(mode, assistantAudioPlaying, pushToTalk);
            if (plan.allowed) {
                stopAssistantAudio();
                return true;
            }
            if (plan.discardWarmMic) discardWarmMic.run();
            if (plan.cancelPushToTalkRelease) cancelPushToTalkRelease.run();
            logRefusal.accept(plan.reason);
            toastRefusal.accept(plan.reason);
            announceRefusal.accept(plan.reason);
            return false;
        }

        void stopAssistantAudio() {
            clearAssistantAudioPlaying.run();
            teardownPriorTurn.run();
        }
    }

    enum EndpointAction {
        WAIT,
        COMMIT,
        CANCEL_NO_SPEECH
    }

    private MoaTurnTakingPolicy() {
    }

    static String canonicalMode(String value) {
        String mode = value == null ? "" : value.trim();
        if (PATIENT.equals(mode) || STRICT.equals(mode)) return mode;
        return RESPONSIVE;
    }

    static long postSpeechSilenceMs(String mode) {
        return RESPONSIVE.equals(canonicalMode(mode)) ? 700 : 1_600;
    }

    static CapturePlan capturePlan(
            String mode, boolean assistantAudioPlaying, boolean pushToTalk) {
        if (STRICT.equals(canonicalMode(mode)) && assistantAudioPlaying) {
            return new CapturePlan(false, false, true, pushToTalk,
                    STRICT_REFUSAL_NOTICE);
        }
        return new CapturePlan(true, true, false, false, "");
    }

    static EndpointAction endpointAction(
            String mode,
            long recordingAgeMs,
            boolean heardSpeech,
            long silenceAfterSpeechMs
    ) {
        if (!heardSpeech) {
            return recordingAgeMs >= NO_SPEECH_TIMEOUT_MS
                    ? EndpointAction.CANCEL_NO_SPEECH : EndpointAction.WAIT;
        }
        if (recordingAgeMs >= STUCK_VAD_BACKSTOP_MS
                || (recordingAgeMs >= MIN_RECORDING_MS
                && silenceAfterSpeechMs >= postSpeechSilenceMs(mode))) {
            return EndpointAction.COMMIT;
        }
        return EndpointAction.WAIT;
    }

    static boolean hasVoiceActivity(byte[] pcm) {
        if (pcm == null || pcm.length < 2) return false;
        long total = 0;
        int samples = 0;
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            int sample = (pcm[i + 1] << 8) | (pcm[i] & 0xff);
            total += Math.abs(sample);
            samples++;
        }
        return samples > 0 && total / samples >= VOICE_ACTIVITY_THRESHOLD;
    }
}

package ag.companion;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

final class MoaVoiceSamplePlayer {
    private static final long SAMPLE_GAP_MS = 350;

    interface Callback {
        void onSampleStarted(String voiceId, int index, int total);

        void onSampleText(String voiceId, String text);

        void onSampleDone(String voiceId, int index, int total);

        void onComplete();

        void onError(String message, Throwable error);
    }

    private static final class VoiceSample {
        final String voiceId;
        final String text;

        VoiceSample(String voiceId, String text) {
            this.voiceId = voiceId;
            this.text = text;
        }
    }

    private final String gatewayUrl;
    private final String gatewayToken;
    private final String sessionId;
    private final Callback callback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<VoiceSample> samples;

    private MoaVoiceGatewaySocket socket;
    private MoaAudioPlaybackController playback;
    private int nextIndex;
    private boolean active;
    private boolean currentFinished;
    private VoiceSample currentSample;
    private String currentTurnId = "";

    MoaVoiceSamplePlayer(String gatewayUrl, String gatewayToken, String sessionId, JSONArray voices, Callback callback) {
        this.gatewayUrl = safe(gatewayUrl);
        this.gatewayToken = safe(gatewayToken);
        this.sessionId = safe(sessionId).isEmpty() ? "voice-sampler-" + UUID.randomUUID().toString() : safe(sessionId);
        this.callback = callback;
        this.samples = parseSamples(voices);
    }

    void start() {
        if (active) {
            return;
        }
        active = true;
        if (samples.isEmpty()) {
            complete();
            return;
        }
        playNext();
    }

    void destroy() {
        active = false;
        cleanupCurrent();
    }

    private void playNext() {
        if (!active) {
            return;
        }
        cleanupCurrent();
        if (nextIndex >= samples.size()) {
            complete();
            return;
        }

        currentSample = samples.get(nextIndex);
        nextIndex++;
        currentFinished = false;
        currentTurnId = "sample_" + UUID.randomUUID().toString();
        playback = new MoaAudioPlaybackController(new MoaAudioPlaybackController.Callback() {
            @Override
            public void onPlaybackStarted() {
            }

            @Override
            public void onPlaybackStopped(boolean drained) {
            }

            @Override
            public void onPlaybackError(String message, Throwable error) {
                fail(message, error);
            }
        });
        socket = new MoaVoiceGatewaySocket(gatewayUrl, gatewayToken, new SocketCallback(currentSample, nextIndex, samples.size()));
        if (callback != null) {
            callback.onSampleStarted(currentSample.voiceId, nextIndex, samples.size());
        }
        socket.connect();
    }

    private void finishCurrent() {
        if (!active || currentFinished) {
            return;
        }
        currentFinished = true;
        VoiceSample finished = currentSample;
        int finishedIndex = nextIndex;
        int total = samples.size();
        cleanupCurrent();
        if (callback != null && finished != null) {
            callback.onSampleDone(finished.voiceId, finishedIndex, total);
        }
        mainHandler.postDelayed(this::playNext, SAMPLE_GAP_MS);
    }

    private void complete() {
        active = false;
        cleanupCurrent();
        if (callback != null) {
            callback.onComplete();
        }
    }

    private void fail(String message, Throwable error) {
        if (!active) {
            return;
        }
        active = false;
        cleanupCurrent();
        if (callback != null) {
            callback.onError(safe(message).isEmpty() ? "Voice sampler failed." : message, error);
        }
    }

    private void cleanupCurrent() {
        MoaVoiceGatewaySocket currentSocket = socket;
        socket = null;
        if (currentSocket != null) {
            currentSocket.destroy();
        }
        MoaAudioPlaybackController currentPlayback = playback;
        playback = null;
        if (currentPlayback != null) {
            currentPlayback.stop();
        }
    }

    private final class SocketCallback implements MoaVoiceGatewaySocket.Callback {
        private final VoiceSample sample;
        private final int index;
        private final int total;

        SocketCallback(VoiceSample sample, int index, int total) {
            this.sample = sample;
            this.index = index;
            this.total = total;
        }

        @Override
        public void onSocketOpen() {
            try {
                MoaVoiceGatewaySocket currentSocket = socket;
                if (!active || currentSocket == null) {
                    return;
                }
                JSONObject override = new JSONObject();
                override.put("voice", sample.voiceId);
                override.put("response_modality", "speech");
                if (!currentSocket.sendSessionStart(sessionId, currentTurnId, "default", override, "android-voice-sampler")) {
                    fail("Could not start voice sample session.", null);
                }
            } catch (JSONException error) {
                fail("Could not build voice sample session.", error);
            }
        }

        @Override
        public void onSocketClosed(int code, String reason) {
            if (active && !currentFinished) {
                finishCurrent();
            }
        }

        @Override
        public void onSocketFailure(String message, Throwable error) {
            fail(message, error);
        }

        @Override
        public void onJsonEvent(JSONObject event) {
        }

        @Override
        public void onSessionReady(String readySessionId) {
            MoaVoiceGatewaySocket currentSocket = socket;
            if (active && currentSocket != null && !currentSocket.sendTextTurn(currentTurnId, sample.text)) {
                fail("Could not send voice sample text.", null);
            }
        }

        @Override
        public void onTranscriptPartial(String turnId, String text) {
        }

        @Override
        public void onTranscriptFinal(String turnId, String text) {
        }

        @Override
        public void onAssistantText(String turnId, String text) {
            if (callback != null) {
                callback.onSampleText(sample.voiceId, text);
            }
        }

        @Override
        public void onAssistantAudioStart(String turnId, JSONObject format, double playbackRate) {
            if (playback != null) {
                playback.start(playbackRate);
            }
        }

        @Override
        public void onAssistantAudioSegment(String turnId, JSONObject segment) {
        }

        @Override
        public void onAssistantAudio(byte[] pcm) {
            if (playback != null && !playback.write(pcm)) {
                fail("Could not play voice sample audio.", null);
            }
        }

        @Override
        public void onAssistantAudioDone(String turnId) {
            MoaAudioPlaybackController currentPlayback = playback;
            if (currentPlayback != null) {
                mainHandler.postDelayed(currentPlayback::stop, 500);
            }
        }

        @Override
        public void onTurnProgress(String turnId) {
            // The sampler plays fixed short clips; keepalives are not tracked.
        }

        @Override
        public void onTurnDone(String turnId, String status, boolean transcriptionOnly,
                boolean ttsSpoke, String replyLanguage, JSONObject terminalEvent) {
            finishCurrent();
        }

        @Override
        public void onTtsRetryDone(String turnId, String retryId, String status,
                int fromTextChar, String error) {
        }

        @Override
        public void onGatewayError(String message) {
            fail(message, null);
        }
    }

    private static List<VoiceSample> parseSamples(JSONArray voices) {
        List<VoiceSample> out = new ArrayList<>();
        if (voices == null) {
            return out;
        }
        for (int i = 0; i < voices.length(); i++) {
            JSONObject voice = voices.optJSONObject(i);
            if (voice == null) {
                continue;
            }
            String voiceId = safe(voice.optString("id", ""));
            if (voiceId.isEmpty()) {
                continue;
            }
            String text = safe(voice.optString("sample_text", ""));
            if (text.isEmpty()) {
                text = "This is " + voiceId + ". This is an Ag voice sample.";
            }
            out.add(new VoiceSample(voiceId, text));
        }
        return out;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

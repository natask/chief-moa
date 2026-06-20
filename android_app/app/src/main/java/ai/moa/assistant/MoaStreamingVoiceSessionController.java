package ai.moa.assistant;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.UUID;

final class MoaStreamingVoiceSessionController {
    interface Callback {
        void onSessionStarted(String sessionId, String turnId);

        void onSessionReady(String sessionId);

        void onRecordingStarted();

        void onRecordingStopped();

        void onTranscriptPartial(String turnId, String text);

        void onTranscriptFinal(String turnId, String text);

        void onAssistantText(String turnId, String text);

        void onAssistantAudioStarted(String turnId);

        void onAssistantAudioDone(String turnId);

        void onTurnDone(String turnId, String status, boolean transcriptionOnly);

        void onSessionClosed();

        void onError(String message, Throwable error);
    }

    private final String gatewayUrl;
    private final String gatewayToken;
    private final boolean playbackEnabled;
    private final String requestedSessionId;
    private final String branchId;
    private final Callback callback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();

    private MoaAudioCaptureController captureController;
    private MoaAudioPlaybackController playbackController;
    private MoaVoiceGatewaySocket gatewaySocket;
    private String sessionId = "";
    private String turnId = "";
    private boolean active;
    private boolean committed;
    private boolean assistantAudioStarted;

    MoaStreamingVoiceSessionController(Callback callback) {
        this(MoaVoiceGatewaySocket.DEFAULT_URL, "", true, "", "default", callback);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, Callback callback) {
        this(gatewayUrl, gatewayToken, playbackEnabled, "", "default", callback);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, String sessionId, String branchId, Callback callback) {
        this.gatewayUrl = safe(gatewayUrl).isEmpty() ? MoaVoiceGatewaySocket.DEFAULT_URL : safe(gatewayUrl);
        this.gatewayToken = safe(gatewayToken);
        this.playbackEnabled = playbackEnabled;
        this.requestedSessionId = safe(sessionId);
        this.branchId = safe(branchId).isEmpty() ? "default" : safe(branchId);
        this.callback = callback;
    }

    boolean isActive() {
        synchronized (lock) {
            return active;
        }
    }

    String sessionId() {
        synchronized (lock) {
            return sessionId;
        }
    }

    String turnId() {
        synchronized (lock) {
            return turnId;
        }
    }

    void startSession() {
        synchronized (lock) {
            if (active) {
                return;
            }
            active = true;
            committed = false;
            assistantAudioStarted = false;
            sessionId = requestedSessionId.isEmpty() ? "mobile-" + UUID.randomUUID().toString() : requestedSessionId;
            turnId = "turn_" + UUID.randomUUID().toString();
            playbackController = new MoaAudioPlaybackController(new PlaybackCallback());
            captureController = new MoaAudioCaptureController(new CaptureCallback());
            gatewaySocket = new MoaVoiceGatewaySocket(gatewayUrl, gatewayToken, new SocketCallback());
            gatewaySocket.connect();
        }
        post(() -> callback.onSessionStarted(sessionId(), turnId()));
    }

    void commitTurn() {
        MoaAudioCaptureController capture;
        MoaVoiceGatewaySocket socket;
        String currentTurnId;
        synchronized (lock) {
            if (!active || committed) {
                return;
            }
            committed = true;
            capture = captureController;
            socket = gatewaySocket;
            currentTurnId = turnId;
        }

        if (capture != null) {
            capture.stop();
        }
        if (socket != null && !socket.sendCommitTurn(currentTurnId)) {
            reportError("Could not send commit_turn to voice gateway.", null);
        }
    }

    void cancel() {
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        MoaVoiceGatewaySocket socket;
        String currentTurnId;
        synchronized (lock) {
            capture = captureController;
            playback = playbackController;
            socket = gatewaySocket;
            currentTurnId = turnId;
            active = false;
            committed = false;
            assistantAudioStarted = false;
        }

        if (capture != null) {
            capture.stop();
        }
        if (playback != null) {
            playback.stop();
        }
        if (socket != null) {
            if (!currentTurnId.isEmpty()) {
                socket.sendCancelTurn(currentTurnId);
            }
            socket.close();
        }
        post(() -> callback.onSessionClosed());
    }

    void destroy() {
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        MoaVoiceGatewaySocket socket;
        synchronized (lock) {
            capture = captureController;
            playback = playbackController;
            socket = gatewaySocket;
            captureController = null;
            playbackController = null;
            gatewaySocket = null;
            active = false;
            committed = false;
            assistantAudioStarted = false;
            sessionId = "";
            turnId = "";
        }

        if (capture != null) {
            capture.stop();
        }
        if (playback != null) {
            playback.stop();
        }
        if (socket != null) {
            socket.destroy();
        }
    }

    private void startSessionAfterSocketOpen() {
        MoaVoiceGatewaySocket socket;
        String currentSessionId;
        String currentTurnId;
        synchronized (lock) {
            if (!active || committed) {
                return;
            }
            socket = gatewaySocket;
            currentSessionId = sessionId;
            currentTurnId = turnId;
        }

        if (socket == null || !socket.sendSessionStart(currentSessionId, currentTurnId, branchId)) {
            reportError("Could not send session_start to voice gateway.", null);
            return;
        }
    }

    private void startCaptureAfterSessionReady() {
        MoaAudioCaptureController capture;
        synchronized (lock) {
            if (!active || committed) {
                return;
            }
            capture = captureController;
        }
        if (capture != null) {
            capture.start();
        }
    }

    private void handleTurnDone(String completedTurnId, String status, boolean transcriptionOnly) {
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        boolean shouldStopPlayback;
        synchronized (lock) {
            capture = captureController;
            playback = playbackController;
            active = false;
            committed = false;
            shouldStopPlayback = !assistantAudioStarted || !"completed".equals(status);
        }
        if (capture != null) {
            capture.stop();
        }
        if (playback != null && shouldStopPlayback) {
            playback.stop();
        }
        post(() -> callback.onTurnDone(completedTurnId, status, transcriptionOnly));
    }

    private void reportError(String message, Throwable error) {
        post(() -> callback.onError(message, error));
    }

    private void post(Runnable runnable) {
        if (callback == null || runnable == null) {
            return;
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            runnable.run();
        } else {
            mainHandler.post(runnable);
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private final class CaptureCallback implements MoaAudioCaptureController.Callback {
        @Override
        public void onPcmChunk(byte[] pcm) {
            MoaVoiceGatewaySocket socket;
            boolean shouldSend;
            synchronized (lock) {
                socket = gatewaySocket;
                shouldSend = active && !committed;
            }
            if (socket != null && shouldSend && !socket.sendAudio(pcm)) {
                reportError("Could not send audio frame to voice gateway.", null);
            }
        }

        @Override
        public void onCaptureStarted() {
            post(() -> callback.onRecordingStarted());
        }

        @Override
        public void onCaptureStopped() {
            post(() -> callback.onRecordingStopped());
        }

        @Override
        public void onCaptureError(String message, Throwable error) {
            reportError(message, error);
        }
    }

    private final class PlaybackCallback implements MoaAudioPlaybackController.Callback {
        @Override
        public void onPlaybackStarted() {
        }

        @Override
        public void onPlaybackStopped() {
        }

        @Override
        public void onPlaybackError(String message, Throwable error) {
            reportError(message, error);
        }
    }

    private final class SocketCallback implements MoaVoiceGatewaySocket.Callback {
        @Override
        public void onSocketOpen() {
            startSessionAfterSocketOpen();
        }

        @Override
        public void onSocketClosed(int code, String reason) {
            boolean wasActive;
            synchronized (lock) {
                wasActive = active;
                active = false;
                committed = false;
            }
            if (wasActive) {
                post(() -> callback.onSessionClosed());
            }
        }

        @Override
        public void onSocketFailure(String message, Throwable error) {
            MoaAudioCaptureController capture;
            MoaAudioPlaybackController playback;
            synchronized (lock) {
                capture = captureController;
                playback = playbackController;
                active = false;
                committed = false;
                assistantAudioStarted = false;
            }
            if (capture != null) {
                capture.stop();
            }
            if (playback != null) {
                playback.stop();
            }
            reportError(message, error);
        }

        @Override
        public void onJsonEvent(JSONObject event) {
        }

        @Override
        public void onSessionReady(String readySessionId) {
            startCaptureAfterSessionReady();
            post(() -> callback.onSessionReady(readySessionId));
        }

        @Override
        public void onTranscriptPartial(String transcriptTurnId, String text) {
            post(() -> callback.onTranscriptPartial(transcriptTurnId, text));
        }

        @Override
        public void onTranscriptFinal(String transcriptTurnId, String text) {
            post(() -> callback.onTranscriptFinal(transcriptTurnId, text));
        }

        @Override
        public void onAssistantText(String assistantTurnId, String text) {
            post(() -> callback.onAssistantText(assistantTurnId, text));
        }

        @Override
        public void onAssistantAudioStart(String audioTurnId, JSONObject format) {
            MoaAudioPlaybackController playback;
            synchronized (lock) {
                playback = playbackController;
                assistantAudioStarted = true;
            }
            if (playback != null && playbackEnabled) {
                playback.start();
            }
            post(() -> callback.onAssistantAudioStarted(audioTurnId));
        }

        @Override
        public void onAssistantAudio(byte[] pcm) {
            MoaAudioPlaybackController playback;
            synchronized (lock) {
                playback = playbackController;
            }
            if (playbackEnabled && playback != null && !playback.write(pcm)) {
                reportError("Could not write assistant audio frame to playback.", null);
            }
        }

        @Override
        public void onAssistantAudioDone(String audioTurnId) {
            MoaAudioPlaybackController playbackToDrain;
            synchronized (lock) {
                playbackToDrain = playbackController;
            }
            mainHandler.postDelayed(() -> {
                synchronized (lock) {
                    if (playbackController == playbackToDrain) {
                        assistantAudioStarted = false;
                    }
                }
                if (playbackToDrain != null && playbackEnabled) {
                    playbackToDrain.stop();
                }
            }, 800);
            post(() -> callback.onAssistantAudioDone(audioTurnId));
        }

        @Override
        public void onTurnDone(String completedTurnId, String status, boolean transcriptionOnly) {
            handleTurnDone(completedTurnId, status, transcriptionOnly);
        }

        @Override
        public void onGatewayError(String message) {
            reportError(message, null);
        }
    }

}

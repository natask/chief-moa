package ai.moa.assistant;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.UUID;

final class MoaStreamingVoiceSessionController {
    private static final String TAG = "MoaStreamingVoice";

    private static final long AUTO_COMMIT_MIN_RECORDING_MS = 650;
    private static final long AUTO_COMMIT_SILENCE_MS = 700;
    private static final long AUTO_COMMIT_MAX_RECORDING_MS = 12000;
    private static final long AUTO_COMMIT_CHECK_MS = 100;
    private static final int VOICE_ACTIVITY_AVERAGE_THRESHOLD = 450;
    private static final int MAX_PENDING_AUDIO_BYTES = MoaAudioCaptureController.SAMPLE_RATE_HZ * 2 * 5;

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
    private final boolean autoCommitOnSilence;
    private final Callback callback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable autoCommitCheck = this::maybeAutoCommitTurn;
    private final Object lock = new Object();

    private MoaAudioCaptureController captureController;
    private MoaAudioPlaybackController playbackController;
    private MoaVoiceGatewaySocket gatewaySocket;
    private String sessionId = "";
    private String turnId = "";
    private boolean active;
    private boolean committed;
    private boolean assistantAudioStarted;
    private boolean loggedVoiceActivity;
    private boolean sessionReady;
    private boolean pendingCommitAfterSessionReady;
    private final ArrayDeque<byte[]> pendingAudioChunks = new ArrayDeque<>();
    private int pendingAudioBytes;
    private long capturedAudioBytes;
    private long recordingStartedAtMs;
    private long lastVoiceActivityAtMs;

    MoaStreamingVoiceSessionController(Callback callback) {
        this(MoaVoiceGatewaySocket.DEFAULT_URL, "", true, "", "default", false, callback);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, Callback callback) {
        this(gatewayUrl, gatewayToken, playbackEnabled, "", "default", false, callback);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, String sessionId, String branchId, Callback callback) {
        this(gatewayUrl, gatewayToken, playbackEnabled, sessionId, branchId, false, callback);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, String sessionId, String branchId, boolean autoCommitOnSilence, Callback callback) {
        this.gatewayUrl = safe(gatewayUrl).isEmpty() ? MoaVoiceGatewaySocket.DEFAULT_URL : safe(gatewayUrl);
        this.gatewayToken = safe(gatewayToken);
        this.playbackEnabled = playbackEnabled;
        this.requestedSessionId = safe(sessionId);
        this.branchId = safe(branchId).isEmpty() ? "default" : safe(branchId);
        this.autoCommitOnSilence = autoCommitOnSilence;
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
            loggedVoiceActivity = false;
            sessionReady = false;
            pendingCommitAfterSessionReady = false;
            clearPendingAudioLocked();
            capturedAudioBytes = 0;
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
            sessionId = requestedSessionId.isEmpty() ? "mobile-" + UUID.randomUUID().toString() : requestedSessionId;
            turnId = "turn_" + UUID.randomUUID().toString();
            playbackController = new MoaAudioPlaybackController(new PlaybackCallback());
            captureController = new MoaAudioCaptureController(new CaptureCallback());
            gatewaySocket = new MoaVoiceGatewaySocket(gatewayUrl, gatewayToken, new SocketCallback());
            gatewaySocket.connect();
        }
        post(() -> callback.onSessionStarted(sessionId(), turnId()));
        startCaptureIfNeeded();
    }

    void commitTurn() {
        MoaAudioCaptureController capture;
        MoaVoiceGatewaySocket socket;
        String currentTurnId;
        boolean shouldFinishNow;
        boolean hasAudio;
        synchronized (lock) {
            if (!active || committed) {
                return;
            }
            committed = true;
            Log.i(TAG, "commitTurn turn_id=" + turnId);
            pendingCommitAfterSessionReady = !sessionReady;
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
            capture = captureController;
            socket = gatewaySocket;
            currentTurnId = turnId;
            shouldFinishNow = sessionReady;
            hasAudio = capturedAudioBytes > 0;
        }
        mainHandler.removeCallbacks(autoCommitCheck);

        if (capture != null) {
            capture.stop();
        }
        if (shouldFinishNow) {
            finishCommittedTurn(socket, currentTurnId, hasAudio);
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
            loggedVoiceActivity = false;
            sessionReady = false;
            pendingCommitAfterSessionReady = false;
            clearPendingAudioLocked();
            capturedAudioBytes = 0;
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
        }
        mainHandler.removeCallbacks(autoCommitCheck);

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
            loggedVoiceActivity = false;
            sessionReady = false;
            pendingCommitAfterSessionReady = false;
            clearPendingAudioLocked();
            capturedAudioBytes = 0;
            sessionId = "";
            turnId = "";
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
        }
        mainHandler.removeCallbacks(autoCommitCheck);

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

    private void startCaptureIfNeeded() {
        MoaAudioCaptureController capture;
        synchronized (lock) {
            if (!active || committed) {
                return;
            }
            capture = captureController;
        }
        if (capture != null && !capture.isRecording()) {
            Log.i(TAG, "startCapture autoCommit=" + autoCommitOnSilence);
            capture.start();
        }
    }

    private boolean markSessionReadyAndFlushAudio(MoaVoiceGatewaySocket socket) {
        if (socket == null) {
            reportError("Could not send audio to voice gateway.", null);
            return false;
        }
        while (true) {
            byte[] chunk;
            synchronized (lock) {
                chunk = pendingAudioChunks.pollFirst();
                if (chunk == null) {
                    pendingAudioBytes = 0;
                    sessionReady = true;
                    return true;
                }
                pendingAudioBytes = Math.max(0, pendingAudioBytes - chunk.length);
            }
            if (socket != null && !socket.sendAudio(chunk)) {
                reportError("Could not send buffered audio frame to voice gateway.", null);
                return false;
            }
        }
    }

    private void finishCommittedTurn(MoaVoiceGatewaySocket socket, String currentTurnId, boolean hasAudio) {
        if (socket == null) {
            reportError("Could not send commit_turn to voice gateway.", null);
            return;
        }
        if (!markSessionReadyAndFlushAudio(socket)) {
            return;
        }
        if (!hasAudio) {
            if (!socket.sendCancelTurn(currentTurnId)) {
                reportError("Could not cancel empty voice turn.", null);
            }
            return;
        }
        if (!socket.sendCommitTurn(currentTurnId)) {
            reportError("Could not send commit_turn to voice gateway.", null);
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
            loggedVoiceActivity = false;
            sessionReady = false;
            pendingCommitAfterSessionReady = false;
            clearPendingAudioLocked();
            capturedAudioBytes = 0;
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
            shouldStopPlayback = !assistantAudioStarted || !"completed".equals(status);
        }
        mainHandler.removeCallbacks(autoCommitCheck);
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

    private void scheduleAutoCommitIfNeeded() {
        if (!autoCommitOnSilence) {
            return;
        }
        synchronized (lock) {
            if (!active || committed) {
                return;
            }
            long now = SystemClock.elapsedRealtime();
            recordingStartedAtMs = now;
            lastVoiceActivityAtMs = 0;
        }
        mainHandler.removeCallbacks(autoCommitCheck);
        mainHandler.postDelayed(autoCommitCheck, AUTO_COMMIT_CHECK_MS);
    }

    private void maybeAutoCommitTurn() {
        boolean shouldCommit = false;
        boolean shouldCancel = false;
        synchronized (lock) {
            if (!active || committed || !autoCommitOnSilence || recordingStartedAtMs <= 0) {
                return;
            }
            long now = SystemClock.elapsedRealtime();
            long recordingAge = now - recordingStartedAtMs;
            boolean heardSpeech = lastVoiceActivityAtMs > 0;
            boolean silentAfterSpeech = heardSpeech
                    && recordingAge >= AUTO_COMMIT_MIN_RECORDING_MS
                    && now - lastVoiceActivityAtMs >= AUTO_COMMIT_SILENCE_MS;
            boolean maxed = recordingAge >= AUTO_COMMIT_MAX_RECORDING_MS;
            shouldCommit = silentAfterSpeech || (heardSpeech && maxed);
            shouldCancel = !heardSpeech && maxed;
        }
        if (shouldCommit) {
            Log.i(TAG, "autoCommit turn");
            commitTurn();
            return;
        }
        if (shouldCancel) {
            Log.i(TAG, "autoCancel turn: no speech detected");
            cancel();
            return;
        }
        mainHandler.postDelayed(autoCommitCheck, AUTO_COMMIT_CHECK_MS);
    }

    private void markVoiceActivity(byte[] pcm) {
        if (!autoCommitOnSilence || pcm == null || pcm.length < 2) {
            return;
        }
        if (!hasVoiceActivity(pcm)) {
            return;
        }
        synchronized (lock) {
            if (active && !committed) {
                lastVoiceActivityAtMs = SystemClock.elapsedRealtime();
                if (!loggedVoiceActivity) {
                    loggedVoiceActivity = true;
                    Log.i(TAG, "firstVoiceActivity");
                }
            }
        }
    }

    private void bufferAudioLocked(byte[] pcm) {
        if (pcm == null || pcm.length == 0) {
            return;
        }
        pendingAudioChunks.addLast(pcm);
        pendingAudioBytes += pcm.length;
        while (pendingAudioBytes > MAX_PENDING_AUDIO_BYTES && !pendingAudioChunks.isEmpty()) {
            byte[] dropped = pendingAudioChunks.removeFirst();
            pendingAudioBytes = Math.max(0, pendingAudioBytes - dropped.length);
        }
    }

    private void clearPendingAudioLocked() {
        pendingAudioChunks.clear();
        pendingAudioBytes = 0;
    }

    private static boolean hasVoiceActivity(byte[] pcm) {
        long total = 0;
        int samples = 0;
        for (int i = 0; i + 1 < pcm.length; i += 2) {
            int low = pcm[i] & 0xff;
            int high = pcm[i + 1];
            int sample = (high << 8) | low;
            total += Math.abs(sample);
            samples += 1;
        }
        return samples > 0 && total / samples >= VOICE_ACTIVITY_AVERAGE_THRESHOLD;
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
            boolean shouldBuffer;
            synchronized (lock) {
                socket = gatewaySocket;
                shouldSend = active && !committed && sessionReady;
                shouldBuffer = active && !committed && !sessionReady;
                if (active && !committed && pcm != null) {
                    capturedAudioBytes += pcm.length;
                }
                if (shouldBuffer) {
                    bufferAudioLocked(pcm);
                }
            }
            markVoiceActivity(pcm);
            if (shouldBuffer) {
                return;
            }
            if (socket != null && shouldSend && !socket.sendAudio(pcm)) {
                reportError("Could not send audio frame to voice gateway.", null);
            }
        }

        @Override
        public void onCaptureStarted() {
            Log.i(TAG, "recordingStarted");
            scheduleAutoCommitIfNeeded();
            post(() -> callback.onRecordingStarted());
        }

        @Override
        public void onCaptureStopped() {
            Log.i(TAG, "recordingStopped");
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
                loggedVoiceActivity = false;
                sessionReady = false;
                pendingCommitAfterSessionReady = false;
                clearPendingAudioLocked();
                capturedAudioBytes = 0;
                recordingStartedAtMs = 0;
                lastVoiceActivityAtMs = 0;
            }
            mainHandler.removeCallbacks(autoCommitCheck);
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
                loggedVoiceActivity = false;
                sessionReady = false;
                pendingCommitAfterSessionReady = false;
                clearPendingAudioLocked();
                capturedAudioBytes = 0;
                recordingStartedAtMs = 0;
                lastVoiceActivityAtMs = 0;
            }
            mainHandler.removeCallbacks(autoCommitCheck);
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
            MoaVoiceGatewaySocket socket;
            String currentTurnId;
            boolean shouldFinishCommit;
            boolean hasAudio;
            synchronized (lock) {
                socket = gatewaySocket;
                currentTurnId = turnId;
                shouldFinishCommit = active && committed && pendingCommitAfterSessionReady;
                pendingCommitAfterSessionReady = false;
                hasAudio = capturedAudioBytes > 0;
            }
            Log.i(TAG, "sessionReady");
            if (shouldFinishCommit) {
                finishCommittedTurn(socket, currentTurnId, hasAudio);
            } else {
                if (markSessionReadyAndFlushAudio(socket)) {
                    startCaptureIfNeeded();
                }
            }
            post(() -> callback.onSessionReady(readySessionId));
        }

        @Override
        public void onTranscriptPartial(String transcriptTurnId, String text) {
            Log.i(TAG, "transcriptPartial chars=" + safe(text).length());
            post(() -> callback.onTranscriptPartial(transcriptTurnId, text));
        }

        @Override
        public void onTranscriptFinal(String transcriptTurnId, String text) {
            Log.i(TAG, "transcriptFinal chars=" + safe(text).length());
            post(() -> callback.onTranscriptFinal(transcriptTurnId, text));
        }

        @Override
        public void onAssistantText(String assistantTurnId, String text) {
            Log.i(TAG, "assistantText chars=" + safe(text).length());
            post(() -> callback.onAssistantText(assistantTurnId, text));
        }

        @Override
        public void onAssistantAudioStart(String audioTurnId, JSONObject format) {
            MoaAudioPlaybackController playback;
            synchronized (lock) {
                playback = playbackController;
                assistantAudioStarted = true;
            }
            Log.i(TAG, "assistantAudioStart");
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
            Log.i(TAG, "assistantAudioDone");
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
            Log.i(TAG, "turnDone status=" + status + " transcriptionOnly=" + transcriptionOnly);
            handleTurnDone(completedTurnId, status, transcriptionOnly);
        }

        @Override
        public void onGatewayError(String message) {
            reportError(message, null);
        }
    }

}

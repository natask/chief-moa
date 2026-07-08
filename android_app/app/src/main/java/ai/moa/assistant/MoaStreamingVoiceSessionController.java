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
    // How long a commit will wait for session_ready before failing the turn.
    // Without this bound a deferred commit could wait forever on a hung socket.
    // Must comfortably exceed the socket connect + session_start round trip
    // (MoaVoiceGatewaySocket.CONNECT_TIMEOUT_MS is 3500ms) so a slow-but-fine
    // connect is not killed by the client's own impatience. The socket connect
    // already starts at double-press-start (startSession), so it overlaps the
    // hold; this only bounds the tail wait after an early release.
    private static final long PENDING_COMMIT_TIMEOUT_MS = 6000;
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

        // A single assistant audio frame arrived. Lets the client re-arm its
        // inactivity watchdog so a mid-stream audio stall is caught, not held
        // open until the gateway's own backstop.
        void onAssistantAudioChunk(String turnId);

        void onAssistantAudioDone(String turnId);

        // Keepalive during a long reasoning / TTS leg. Re-arms the watchdog.
        void onTurnProgress(String turnId);

        void onTurnDone(String turnId, String status, boolean transcriptionOnly, boolean ttsSpoke, String replyLanguage);

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
    private final Runnable pendingCommitTimeout = this::failPendingCommitTurn;
    private final Object lock = new Object();

    private MoaAudioCaptureController captureController;
    // A microphone already warmed by the gesture. When present, startSession
    // adopts it instead of constructing a cold AudioRecord, so the pre-roll ring
    // (the head of the utterance captured before the hold confirmed) flows into
    // this turn. Set once before startSession(); consumed there.
    private MoaAudioCaptureController prewarmedCapture;
    private MoaAudioPlaybackController playbackController;
    private MoaVoiceGatewaySocket gatewaySocket;
    private String sessionId = "";
    private String turnId = "";
    private boolean active;
    private boolean committed;
    // Set the instant a commit is requested, before capture is stopped. It keeps
    // commitTurn from running twice while capture.stop() joins the capture thread,
    // but unlike `committed` it does NOT gate chunk accumulation, so PCM frames
    // still in flight during the stop keep counting and buffering.
    private boolean commitRequested;
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

    // Hand this session a mic the gesture already warmed. Must be called before
    // startSession(); a null clears any prior hand-off and falls back to a cold
    // start. The warm mic's ~500ms pre-roll drains into this turn on go-live.
    void setPrewarmedCapture(MoaAudioCaptureController capture) {
        synchronized (lock) {
            prewarmedCapture = capture;
        }
    }

    void startSession() {
        synchronized (lock) {
            if (active) {
                return;
            }
            active = true;
            committed = false;
            commitRequested = false;
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
            // Adopt a gesture-warmed mic when one was handed over; otherwise a
            // fresh controller cold-starts on the first startCaptureIfNeeded. The
            // CaptureCallback is attached at start()/go-live time, not here.
            captureController = prewarmedCapture != null ? prewarmedCapture : new MoaAudioCaptureController();
            prewarmedCapture = null;
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
            if (!active || committed || commitRequested) {
                return;
            }
            // Mark the commit requested but do NOT flip `committed` yet. Chunks
            // arriving from the capture thread must keep counting/buffering until
            // capture.stop() has joined that thread, so a short utterance is not
            // read as zero audio just because the release beat the last frame.
            commitRequested = true;
            Log.i(TAG, "commitTurn turn_id=" + turnId);
            capture = captureController;
        }
        mainHandler.removeCallbacks(autoCommitCheck);

        // Stop capture first. stop() joins the moa-audio-capture thread (up to
        // 500ms), draining every already-read PCM chunk into onPcmChunk before we
        // decide commit vs cancel below.
        if (capture != null) {
            capture.stop();
        }

        synchronized (lock) {
            // A teardown (cancel/destroy/turn_done/socket close) may have raced in
            // while capture was stopping. If the turn is no longer active or the
            // commit was cleared, abandon it.
            if (!active || !commitRequested) {
                commitRequested = false;
                return;
            }
            committed = true;
            commitRequested = false;
            pendingCommitAfterSessionReady = !sessionReady;
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
            socket = gatewaySocket;
            currentTurnId = turnId;
            shouldFinishNow = sessionReady;
            hasAudio = capturedAudioBytes > 0;
        }

        if (shouldFinishNow) {
            finishCommittedTurn(socket, currentTurnId, hasAudio);
        } else {
            // session_ready has not arrived yet; the commit is deferred to
            // onSessionReady. Bound that wait so a hung socket fails the turn
            // with a visible error instead of hanging silently forever.
            mainHandler.removeCallbacks(pendingCommitTimeout);
            mainHandler.postDelayed(pendingCommitTimeout, PENDING_COMMIT_TIMEOUT_MS);
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
        mainHandler.removeCallbacks(pendingCommitTimeout);

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
        mainHandler.removeCallbacks(pendingCommitTimeout);

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
            // Also bail when a commit is in flight: session_ready can arrive while
            // commitTurn is joining the capture thread (committed not yet set), and
            // we must not restart the mic we are in the middle of stopping.
            if (!active || committed || commitRequested) {
                return;
            }
            capture = captureController;
        }
        // isLive() (not isRecording()) is the guard: a warmed mic is already
        // "recording" into its ring but not yet delivering, so it must still be
        // taken live here. Push-to-talk drains the pre-roll to catch the head of
        // speech; the silence-VAD path drops it so stale gap audio never trips VAD.
        if (capture != null && !capture.isLive()) {
            Log.i(TAG, "startCapture autoCommit=" + autoCommitOnSilence);
            capture.start(new CaptureCallback(), !autoCommitOnSilence);
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
            // Truly nothing captured. Cancel the empty turn on the gateway, but do
            // not wait for it to answer: a cancelled turn gets no turn_done, so
            // without a local notify the UI would hang until the 15s watchdog.
            // Surface a no_speech turn_done so the overlay says "didn't catch that"
            // and returns to ready immediately.
            Log.i(TAG, "commit with zero captured audio; cancelling and reporting no_speech");
            socket.sendCancelTurn(currentTurnId);
            handleTurnDone(currentTurnId, "no_speech", false, false, "");
            return;
        }
        if (!socket.sendCommitTurn(currentTurnId)) {
            reportError("Could not send commit_turn to voice gateway.", null);
        }
    }

    private void failPendingCommitTurn() {
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        MoaVoiceGatewaySocket socket;
        String currentTurnId;
        synchronized (lock) {
            // Only fail if the turn is still waiting for session_ready. If the
            // commit already finished (or the turn was torn down), do nothing.
            if (!active || !committed || !pendingCommitAfterSessionReady) {
                return;
            }
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
        Log.w(TAG, "pending commit timed out before session_ready");
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
        reportError("Voice gateway did not become ready in time. Tap to try again.", null);
    }

    private void handleTurnDone(String completedTurnId, String status, boolean transcriptionOnly, boolean ttsSpoke, String replyLanguage) {
        mainHandler.removeCallbacks(pendingCommitTimeout);
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
        post(() -> callback.onTurnDone(completedTurnId, status, transcriptionOnly, ttsSpoke, replyLanguage));
    }

    private void reportError(String message, Throwable error) {
        mainHandler.removeCallbacks(pendingCommitTimeout);
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
            mainHandler.removeCallbacks(pendingCommitTimeout);
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
            mainHandler.removeCallbacks(pendingCommitTimeout);
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
            mainHandler.removeCallbacks(pendingCommitTimeout);
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
        public void onAssistantAudioStart(String audioTurnId, JSONObject format, double playbackRate) {
            MoaAudioPlaybackController playback;
            synchronized (lock) {
                playback = playbackController;
                assistantAudioStarted = true;
            }
            Log.i(TAG, "assistantAudioStart playbackRate=" + playbackRate);
            if (playback != null && playbackEnabled) {
                playback.start(playbackRate);
            }
            post(() -> callback.onAssistantAudioStarted(audioTurnId));
        }

        @Override
        public void onAssistantAudio(byte[] pcm) {
            MoaAudioPlaybackController playback;
            String currentTurnId;
            synchronized (lock) {
                playback = playbackController;
                currentTurnId = turnId;
            }
            if (playbackEnabled && playback != null && !playback.write(pcm)) {
                reportError("Could not write assistant audio frame to playback.", null);
            }
            // Prove liveness on every frame so a mid-stream stall is caught.
            post(() -> callback.onAssistantAudioChunk(currentTurnId));
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
        public void onTurnProgress(String progressTurnId) {
            post(() -> callback.onTurnProgress(progressTurnId));
        }

        @Override
        public void onTurnDone(String completedTurnId, String status, boolean transcriptionOnly, boolean ttsSpoke, String replyLanguage) {
            Log.i(TAG, "turnDone status=" + status + " transcriptionOnly=" + transcriptionOnly + " ttsSpoke=" + ttsSpoke);
            handleTurnDone(completedTurnId, status, transcriptionOnly, ttsSpoke, replyLanguage);
        }

        @Override
        public void onGatewayError(String message) {
            reportError(message, null);
        }
    }

}

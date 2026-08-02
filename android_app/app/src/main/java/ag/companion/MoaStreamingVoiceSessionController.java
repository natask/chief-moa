package ag.companion;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Choreographer;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.UUID;

final class MoaStreamingVoiceSessionController {
    private static final String TAG = "MoaStreamingVoice";
    static final long DRAFT_READY_TIMEOUT_MS = 10000;
    static final long DRAFT_CONTROL_ACK_TIMEOUT_MS = 6000;

    private static final long AUTO_COMMIT_MIN_RECORDING_MS = 650;
    private static final long AUTO_COMMIT_SILENCE_MS = 700;
    // NOT a product limit on how long the user may speak. Audio is streamed to
    // the gateway frame-by-frame, so an utterance can run indefinitely. Once
    // speech has been heard, the turn ends on the silence VAD above; this 30-min
    // value is only a safety backstop that force-commits if the VAD gets stuck
    // and never detects the end-of-speech silence. It should never be hit by a
    // real turn.
    private static final long AUTO_COMMIT_STUCK_VAD_BACKSTOP_MS = 1_800_000;
    // Separate, short give-up for a session where NO speech was ever detected
    // (mic opened but the user never spoke): cancel so the orb returns to idle
    // instead of listening forever. This bounds silence, not speech.
    private static final long AUTO_COMMIT_NO_SPEECH_TIMEOUT_MS = 12000;
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

        void onAudioCaptured();

        void onRecordingStopped();

        void onTranscriptPartial(String turnId, String text);

        void onTranscriptFinal(String turnId, String text);

        void onAssistantText(String turnId, String text);

        void onAssistantAudioStarted(String turnId);

        // A single assistant audio frame arrived. Lets the client re-arm its
        // inactivity watchdog so a mid-stream audio stall is caught, not held
        // open until the gateway's own backstop.
        void onAssistantAudioChunk(String turnId);

        /** Frame-coalesced text position derived from AudioTrack's playback head. */
        void onAssistantPlaybackProgress(String turnId, String text, int spokenChars);

        void onAssistantAudioDone(String turnId);

        // Keepalive during a long reasoning / TTS leg. Re-arms the watchdog.
        void onTurnProgress(String turnId);

        void onTurnDone(String turnId, String status, boolean transcriptionOnly, boolean ttsSpoke,
                String replyLanguage, JSONObject terminalEvent);

        void onTtsRetryDone(String turnId, String retryId, String status, int fromTextChar, String error);

        void onSessionClosed();

        default void onVoiceDraftStateChanged(boolean ready, boolean paused) {
        }

        void onError(String message, Throwable error);
    }

    private final String gatewayUrl;
    private final String gatewayToken;
    private volatile boolean playbackEnabled;
    private final String requestedSessionId;
    private String requestedTurnId = "";
    private String deviceId = "";
    private final String branchId;
    private final boolean autoCommitOnSilence;
    private boolean transcriptionOnly;
    private final Callback callback;
    private final Context metricsContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable autoCommitCheck = this::maybeAutoCommitTurn;
    private final Runnable pendingCommitTimeout = this::failPendingCommitTurn;
    private final Runnable draftReadyTimeout = () -> failDraftWait(false);
    private final Runnable draftControlTimeout = () -> failDraftWait(true);
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
    private long playbackDrainGeneration;
    private boolean loggedVoiceActivity;
    private boolean sessionReady;
    private boolean pendingCommitAfterSessionReady;
    private final ArrayDeque<byte[]> pendingAudioChunks = new ArrayDeque<>();
    private final MoaAssistantAudioProgressTracker assistantAudioProgress = new MoaAssistantAudioProgressTracker();
    private final MoaAssistantOutputState assistantOutputState = new MoaAssistantOutputState();
    private final MoaVoicePlaybackDrainGate playbackDrainGate = new MoaVoicePlaybackDrainGate();
    private int pendingAudioBytes;
    private long capturedAudioBytes;
    private long recordingStartedAtMs;
    private long lastVoiceActivityAtMs;
    private MoaVoiceLifecycleTrace lifecycleTrace;
    private boolean lifecyclePlaybackCompleted;
    private boolean lifecyclePlaybackStopped;
    private boolean lifecyclePlaybackDrainConfirmed;
    private boolean lifecycleAudioReceived;
    private String pendingLifecycleCompletionStatus = "";
    private boolean pendingLifecycleTtsExpected;
    private boolean pendingLifecycleAudioReceived;
    private String pendingDeviceAudioDoneTurnId = "";
    private boolean playbackFrameScheduled;
    private boolean voiceDraftEnabled;
    private boolean voiceDraftPaused;
    private boolean voiceDraftControlPending;
    private boolean suppressDraftCaptureStopped;
    private boolean draftCommitAfterControl;
    private String voiceDraftId = "";
    private long voiceDraftRevision;

    private final Choreographer.FrameCallback playbackFrameCallback = this::onPlaybackFrame;

    private void onPlaybackFrame(long frameTimeNanos) {
        MoaAudioPlaybackController playback;
        String currentTurnId;
        String text;
        int chars;
        boolean keepGoing;
        synchronized (lock) {
            playbackFrameScheduled = false;
            playback = playbackController;
            currentTurnId = turnId;
            keepGoing = assistantAudioStarted
                    && playbackEnabled && playback != null && callback != null;
            MoaAssistantAudioProgressTracker.PlaybackProgress progress =
                    assistantAudioProgress.snapshot(playback == null ? 0L : playback.playedPcmFrames());
            text = assistantAudioProgress.streamedText();
            chars = progress.assistantTextChars;
        }
        if (keepGoing) {
            callback.onAssistantPlaybackProgress(currentTurnId, text, chars);
            schedulePlaybackFrame();
        }
    }

    MoaStreamingVoiceSessionController(Callback callback) {
        this(MoaVoiceGatewaySocket.DEFAULT_URL, "", true, "", "default", false, callback, null);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, Callback callback) {
        this(gatewayUrl, gatewayToken, playbackEnabled, "", "default", false, callback, null);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, String sessionId, String branchId, Callback callback) {
        this(gatewayUrl, gatewayToken, playbackEnabled, sessionId, branchId, false, callback, null);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, String sessionId, String branchId, boolean autoCommitOnSilence, Callback callback) {
        this(gatewayUrl, gatewayToken, playbackEnabled, sessionId, branchId, autoCommitOnSilence, callback, null);
    }

    MoaStreamingVoiceSessionController(String gatewayUrl, String gatewayToken, boolean playbackEnabled, String sessionId, String branchId, boolean autoCommitOnSilence, Callback callback, Context metricsContext) {
        this.gatewayUrl = safe(gatewayUrl).isEmpty() ? MoaVoiceGatewaySocket.DEFAULT_URL : safe(gatewayUrl);
        this.gatewayToken = safe(gatewayToken);
        this.playbackEnabled = playbackEnabled;
        this.requestedSessionId = safe(sessionId);
        this.branchId = safe(branchId).isEmpty() ? "default" : safe(branchId);
        this.autoCommitOnSilence = autoCommitOnSilence;
        this.callback = callback;
        this.metricsContext = metricsContext == null ? null : metricsContext.getApplicationContext();
    }

    boolean isActive() {
        synchronized (lock) {
            return active;
        }
    }

    void setPlaybackEnabled(boolean enabled) {
        playbackEnabled = enabled;
    }

    void setTranscriptionOnly(boolean enabled) {
        synchronized (lock) {
            if (!active) {
                transcriptionOnly = enabled;
            }
        }
    }

    void setVoiceDraftEnabled(boolean enabled) {
        synchronized (lock) {
            if (!active) voiceDraftEnabled = enabled;
        }
    }

    boolean isVoiceDraftReady() {
        synchronized (lock) {
            return voiceDraftEnabled && !voiceDraftId.isEmpty()
                    && !voiceDraftControlPending && !committed && !commitRequested;
        }
    }

    boolean isVoiceDraftPaused() {
        synchronized (lock) {
            return voiceDraftEnabled && voiceDraftPaused;
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

    void setTurnIdentity(String nextTurnId, String nextDeviceId) {
        synchronized (lock) {
            requestedTurnId = safe(nextTurnId);
            deviceId = safe(nextDeviceId);
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
            voiceDraftPaused = false;
            voiceDraftControlPending = false;
            suppressDraftCaptureStopped = false;
            draftCommitAfterControl = false;
            voiceDraftId = "";
            voiceDraftRevision = 0L;
            assistantAudioProgress.reset();
            clearPendingAudioLocked();
            capturedAudioBytes = 0;
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
            sessionId = requestedSessionId.isEmpty() ? "mobile-" + UUID.randomUUID().toString() : requestedSessionId;
            turnId = requestedTurnId.isEmpty() ? "turn_" + UUID.randomUUID().toString() : requestedTurnId;
            assistantOutputState.begin(turnId);
            playbackController = new MoaAudioPlaybackController(new PlaybackCallback());
            // Adopt a gesture-warmed mic when one was handed over; otherwise a
            // fresh controller cold-starts on the first startCaptureIfNeeded. The
            // CaptureCallback is attached at start()/go-live time, not here.
            captureController = prewarmedCapture != null ? prewarmedCapture : new MoaAudioCaptureController();
            prewarmedCapture = null;
            lifecycleTrace = new MoaVoiceLifecycleTrace(
                    SystemClock::elapsedRealtime,
                    event -> {
                        Log.i(TAG, "lifecycle " + event);
                        if (metricsContext != null) {
                            MoaVoiceE2eMetricsStore.record(metricsContext, event);
                        }
                    },
                    MoaVoiceLifecycleTrace.correlationId(sessionId, turnId));
            lifecyclePlaybackCompleted = false;
            lifecyclePlaybackStopped = false;
            lifecyclePlaybackDrainConfirmed = false;
            lifecycleAudioReceived = false;
            pendingLifecycleCompletionStatus = "";
            pendingLifecycleTtsExpected = false;
            pendingLifecycleAudioReceived = false;
            pendingDeviceAudioDoneTurnId = "";
            playbackDrainGate.reset();
            playbackDrainGeneration++;
            gatewaySocket = new MoaVoiceGatewaySocket(gatewayUrl, gatewayToken, new SocketCallback());
            gatewaySocket.connect();
        }
        post(() -> callback.onSessionStarted(sessionId(), turnId()));
        startCaptureIfNeeded();
    }

    void toggleVoiceDraftPause() {
        MoaAudioCaptureController capture;
        MoaVoiceGatewaySocket socket;
        String action;
        String id;
        long revision;
        synchronized (lock) {
            if (!active || !voiceDraftEnabled || voiceDraftId.isEmpty()
                    || voiceDraftControlPending || committed || commitRequested) return;
            action = voiceDraftPaused ? "resume" : "pause";
            voiceDraftControlPending = true;
            capture = captureController;
            socket = gatewaySocket;
            id = voiceDraftId;
            revision = voiceDraftRevision;
            suppressDraftCaptureStopped = !voiceDraftPaused;
        }
        if ("pause".equals(action) && capture != null) capture.stop();
        if (socket == null || !socket.sendVoiceDraftControl(sessionId(), branchId, turnId(), id,
                revision, action, "android-" + action + "-" + turnId() + "-" + revision)) {
            synchronized (lock) { voiceDraftControlPending = false; }
            reportError("Could not " + action + " voice draft.", null);
        } else {
            mainHandler.postDelayed(draftControlTimeout, DRAFT_CONTROL_ACK_TIMEOUT_MS);
        }
    }

    void discardVoiceDraft() {
        MoaAudioCaptureController capture;
        MoaVoiceGatewaySocket socket;
        String id;
        long revision;
        synchronized (lock) {
            if (!active || !voiceDraftEnabled || voiceDraftId.isEmpty()
                    || voiceDraftControlPending || committed || commitRequested) return;
            voiceDraftControlPending = true;
            suppressDraftCaptureStopped = true;
            capture = captureController;
            socket = gatewaySocket;
            id = voiceDraftId;
            revision = voiceDraftRevision;
        }
        if (capture != null) capture.stop();
        if (socket == null || !socket.sendVoiceDraftControl(sessionId(), branchId, turnId(), id,
                revision, "discard", "android-discard-" + turnId() + "-" + revision)) {
            synchronized (lock) { voiceDraftControlPending = false; }
            reportError("Could not discard voice draft.", null);
        } else {
            mainHandler.postDelayed(draftControlTimeout, DRAFT_CONTROL_ACK_TIMEOUT_MS);
        }
    }

    private void schedulePlaybackFrame() {
        if (playbackFrameScheduled) return;
        playbackFrameScheduled = true;
        Choreographer.getInstance().postFrameCallback(playbackFrameCallback);
    }

    private void cancelPlaybackFrames() {
        if (!playbackFrameScheduled) return;
        Choreographer.getInstance().removeFrameCallback(playbackFrameCallback);
        playbackFrameScheduled = false;
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
            if (voiceDraftEnabled && voiceDraftControlPending) {
                draftCommitAfterControl = true;
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
            if (lifecycleTrace != null) {
                lifecycleTrace.commitRequested(hasAudio);
            }
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
        markLifecycleTeardown("user_cancel");
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        MoaVoiceGatewaySocket socket;
        String currentTurnId;
        MoaAssistantAudioProgressTracker.PlaybackProgress finalPlaybackProgress;
        synchronized (lock) {
            capture = captureController;
            playback = playbackController;
            socket = gatewaySocket;
            currentTurnId = turnId;
            active = false;
            playbackDrainGeneration++;
            assistantOutputState.suppressSpeech();
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
        // Stop playback FIRST, then read how far it got: the interrupt's
        // cancel_turn carries played_ms so the gateway knows where speech
        // stopped. stop() captures the head position before flushing it.
        long playedMs = -1;
        long playedPcmFrames = 0L;
        if (playback != null) {
            playback.stop();
            playedMs = playback.lastPlayedMs();
            playedPcmFrames = playback.playedPcmFrames();
        }
        synchronized (lock) {
            finalPlaybackProgress = assistantAudioProgress.snapshot(playedPcmFrames);
        }
        maybeSendFinalPlaybackProgress(socket, currentTurnId, finalPlaybackProgress, "cancel");
        if (socket != null) {
            if (!currentTurnId.isEmpty()) {
                socket.sendCancelTurn(currentTurnId, playedMs);
            }
            socket.close();
        }
        post(() -> callback.onSessionClosed());
    }

    /** Cancel immediately while persisting the identity of the replacement turn. */
    void cancelForReplacement(String nextTurnId, String boundaryId, String replacementKind) {
        markLifecycleTeardown("replacement");
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
            playbackDrainGeneration++;
            assistantOutputState.suppressSpeech();
            committed = false;
            pendingCommitAfterSessionReady = false;
        }
        mainHandler.removeCallbacks(autoCommitCheck);
        mainHandler.removeCallbacks(pendingCommitTimeout);
        if (capture != null) capture.stop();
        long playedPcmFrames = 0L;
        if (playback != null) {
            playback.stop();
            playedPcmFrames = playback.playedPcmFrames();
        }
        MoaAssistantAudioProgressTracker.PlaybackProgress progress;
        synchronized (lock) {
            progress = assistantAudioProgress.snapshot(playedPcmFrames);
        }
        maybeSendFinalPlaybackProgress(socket, currentTurnId, progress, "steer");
        if (socket != null) {
            socket.sendReplacementCancel(currentTurnId,
                    playback == null ? -1 : playback.lastPlayedMs(),
                    nextTurnId, boundaryId, replacementKind);
            socket.close();
        }
    }

    void destroy() {
        markLifecycleTeardown("destroy");
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        MoaVoiceGatewaySocket socket;
        String currentTurnId;
        MoaAssistantAudioProgressTracker.PlaybackProgress finalPlaybackProgress;
        synchronized (lock) {
            capture = captureController;
            playback = playbackController;
            socket = gatewaySocket;
            currentTurnId = turnId;
            finalPlaybackProgress = assistantAudioProgress.snapshot(playback != null ? playback.playedPcmFrames() : 0L);
            captureController = null;
            playbackController = null;
            gatewaySocket = null;
            active = false;
            playbackDrainGeneration++;
            assistantOutputState.suppressSpeech();
            committed = false;
            assistantAudioStarted = false;
            loggedVoiceActivity = false;
            sessionReady = false;
            pendingCommitAfterSessionReady = false;
            assistantAudioProgress.reset();
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
        maybeSendFinalPlaybackProgress(socket, currentTurnId, finalPlaybackProgress, "close");
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

        boolean draft;
        synchronized (lock) { draft = voiceDraftEnabled; }
        boolean sent = draft
                ? socket != null && socket.sendVoiceDraftStart(currentSessionId, currentTurnId, branchId,
                        transcriptionOnly ? "android-launcher-dictation" : "android-overlay",
                        deviceId, transcriptionOnly)
                : socket != null && socket.sendSessionStart(currentSessionId, currentTurnId, branchId,
                        null, transcriptionOnly ? "android-launcher-dictation" : "android-overlay",
                        deviceId, transcriptionOnly);
        if (!sent) {
            reportError("Could not send session_start to voice gateway.", null);
            return;
        }
        if (draft) mainHandler.postDelayed(draftReadyTimeout, DRAFT_READY_TIMEOUT_MS);
    }

    private void failDraftWait(boolean control) {
        boolean failed;
        synchronized (lock) {
            failed = active && voiceDraftEnabled
                    && (control ? voiceDraftControlPending : voiceDraftId.isEmpty());
        }
        if (failed) reportError(control
                ? "Voice draft control was not acknowledged."
                : "Voice draft authority was not acknowledged.", null);
    }

    private void handleVoiceDraftEvent(JSONObject event) {
        if (event == null) return;
        String type = safe(event.optString("type", ""));
        if (!("session_ready".equals(type) || "voice_draft_state".equals(type))) return;
        JSONObject draft = event.optJSONObject("voice_draft");
        if (draft == null) return;
        boolean ready;
        boolean paused;
        boolean discarded;
        boolean notifyControls;
        boolean commitAfterControl;
        synchronized (lock) {
            if (!voiceDraftEnabled
                    || !sessionId.equals(event.optString("session_id", ""))
                    || !branchId.equals(event.optString("branch_id", ""))
                    || !turnId.equals(event.optString("turn_id", ""))) return;
            String id = safe(draft.optString("draft_id", ""));
            long revision = draft.optLong("revision", -1L);
            String state = safe(draft.optString("state", ""));
            if (!MoaVoiceDraftPointer.isAuthorityToken(id) || revision <= 0L
                    || (!voiceDraftId.isEmpty() && !voiceDraftId.equals(id))
                    || revision < voiceDraftRevision) return;
            if ("session_ready".equals(type)) {
                JSONObject capabilities = event.optJSONObject("capabilities");
                JSONObject capability = capabilities == null
                        ? null : capabilities.optJSONObject("voice_drafts_v1");
                if (capability == null || !capability.optBoolean("supported", false)
                        || !"capturing".equals(state)) return;
            } else if (revision <= voiceDraftRevision) {
                return;
            }
            voiceDraftId = id;
            voiceDraftRevision = revision;
            voiceDraftControlPending = false;
            commitAfterControl = draftCommitAfterControl;
            draftCommitAfterControl = false;
            voiceDraftPaused = "paused".equals(state);
            ready = "capturing".equals(state) || voiceDraftPaused;
            paused = voiceDraftPaused;
            discarded = "discarded".equals(state);
            notifyControls = ready || discarded;
            if (discarded) active = false;
        }
        mainHandler.removeCallbacks(draftReadyTimeout);
        mainHandler.removeCallbacks(draftControlTimeout);
        if (ready && !paused && !commitAfterControl && "voice_draft_state".equals(type)) {
            startCaptureIfNeeded();
        }
        if (notifyControls) post(() -> callback.onVoiceDraftStateChanged(ready, paused));
        if (commitAfterControl && ready) post(MoaStreamingVoiceSessionController.this::commitTurn);
        if (discarded) {
            MoaVoiceGatewaySocket socket;
            synchronized (lock) { socket = gatewaySocket; }
            if (socket != null) socket.close();
        }
    }

    private void markLifecycleTeardown(String reason) {
        synchronized (lock) {
            if (lifecycleTrace != null) {
                lifecycleTrace.tornDown(reason);
            }
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
            handleTurnDone(currentTurnId, "no_speech", false, false, "", new JSONObject());
            return;
        }
        boolean sent;
        synchronized (lock) {
            sent = voiceDraftEnabled
                    ? socket.sendVoiceDraftCommit(sessionId, branchId, currentTurnId,
                            voiceDraftId, voiceDraftRevision,
                            "android-send-" + currentTurnId + "-" + voiceDraftRevision)
                    : socket.sendCommitTurn(currentTurnId);
        }
        if (!sent) {
            reportError("Could not send commit_turn to voice gateway.", null);
        }
    }

    private void failPendingCommitTurn() {
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        MoaVoiceGatewaySocket socket;
        String currentTurnId;
        MoaAssistantAudioProgressTracker.PlaybackProgress finalPlaybackProgress;
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
            finalPlaybackProgress = assistantAudioProgress.snapshot(playback != null ? playback.playedPcmFrames() : 0L);
            active = false;
            playbackDrainGeneration++;
            assistantOutputState.suppressSpeech();
            committed = false;
            assistantAudioStarted = false;
            loggedVoiceActivity = false;
            sessionReady = false;
            pendingCommitAfterSessionReady = false;
            assistantAudioProgress.reset();
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
        maybeSendFinalPlaybackProgress(socket, currentTurnId, finalPlaybackProgress, "close");
        if (playback != null) {
            playback.stop();
        }
        if (socket != null) {
            if (!currentTurnId.isEmpty()) {
                socket.sendCancelTurn(currentTurnId);
            }
            socket.close();
        }
        reportError("Voice gateway did not become ready in time.", null);
    }

    private void handleTurnDone(String completedTurnId, String status, boolean transcriptionOnly,
            boolean ttsSpoke, String replyLanguage, JSONObject terminalEvent) {
        mainHandler.removeCallbacks(pendingCommitTimeout);
        MoaAudioCaptureController capture;
        MoaAudioPlaybackController playback;
        boolean shouldStopPlayback;
        synchronized (lock) {
            if (lifecycleTrace != null) {
                if ("error".equals(status)) {
                    lifecycleTrace.failed("gateway");
                } else if ("completed".equals(status)
                        && ttsSpoke
                        && lifecycleAudioReceived
                        && playbackEnabled
                        && !lifecyclePlaybackCompleted) {
                    if (lifecyclePlaybackStopped) {
                        lifecycleTrace.failed("playback incomplete");
                    } else {
                        pendingLifecycleCompletionStatus = status;
                        pendingLifecycleTtsExpected = true;
                        pendingLifecycleAudioReceived = true;
                    }
                } else {
                    lifecycleTrace.completed(status, ttsSpoke, lifecycleAudioReceived);
                }
            }
            capture = captureController;
            playback = playbackController;
            active = false;
            assistantOutputState.suppressSpeech();
            committed = false;
            loggedVoiceActivity = false;
            sessionReady = false;
            pendingCommitAfterSessionReady = false;
            clearPendingAudioLocked();
            capturedAudioBytes = 0;
            recordingStartedAtMs = 0;
            lastVoiceActivityAtMs = 0;
            shouldStopPlayback = playbackDrainGate.shouldStopOnTurnDone(status);
        }
        mainHandler.removeCallbacks(autoCommitCheck);
        if (capture != null) {
            capture.stop();
        }
        if (playback != null && shouldStopPlayback) {
            playback.stop();
        }
        post(() -> callback.onTurnDone(completedTurnId, status, transcriptionOnly, ttsSpoke,
                replyLanguage, terminalEvent));
    }

    boolean retryTts(String completedTurnId, String retryId, int fromTextChar) {
        MoaAudioPlaybackController playback;
        MoaVoiceGatewaySocket socket;
        synchronized (lock) {
            if (gatewaySocket == null || safe(completedTurnId).isEmpty() || safe(retryId).isEmpty()) {
                return false;
            }
            playback = playbackController;
            socket = gatewaySocket;
            playbackDrainGeneration++;
            turnId = completedTurnId;
            assistantOutputState.begin(completedTurnId);
            assistantAudioStarted = false;
            assistantAudioProgress.reset();
            playbackDrainGate.reset();
            pendingDeviceAudioDoneTurnId = "";
        }
        if (playback != null) {
            playback.stop();
        }
        return socket.sendTtsRetry(completedTurnId, retryId, fromTextChar);
    }

    private void reportError(String message, Throwable error) {
        mainHandler.removeCallbacks(pendingCommitTimeout);
        synchronized (lock) {
            if (lifecycleTrace != null) {
                lifecycleTrace.failed(message);
            }
        }
        post(() -> callback.onError(message, error));
    }

    private void maybeSendFinalPlaybackProgress(MoaVoiceGatewaySocket socket, String currentTurnId, MoaAssistantAudioProgressTracker.PlaybackProgress progress, String reason) {
        if (socket == null || safe(currentTurnId).isEmpty()) {
            return;
        }
        socket.sendPlaybackProgress(currentTurnId, progress, reason);
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
            boolean backstopReached = recordingAge >= AUTO_COMMIT_STUCK_VAD_BACKSTOP_MS;
            boolean noSpeechTimedOut = !heardSpeech && recordingAge >= AUTO_COMMIT_NO_SPEECH_TIMEOUT_MS;
            shouldCommit = silentAfterSpeech || (heardSpeech && backstopReached);
            shouldCancel = noSpeechTimedOut;
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
            boolean firstAudio;
            synchronized (lock) {
                socket = gatewaySocket;
                shouldSend = active && !committed && sessionReady;
                shouldBuffer = active && !committed && !sessionReady;
                firstAudio = active
                        && !committed
                        && capturedAudioBytes == 0
                        && pcm != null
                        && pcm.length > 0;
                if (active && !committed && pcm != null) {
                    capturedAudioBytes += pcm.length;
                }
                if (shouldBuffer) {
                    bufferAudioLocked(pcm);
                }
            }
            if (firstAudio) {
                post(callback::onAudioCaptured);
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
            synchronized (lock) {
                if (lifecycleTrace != null) {
                    lifecycleTrace.captureStarted();
                }
            }
            scheduleAutoCommitIfNeeded();
            post(() -> callback.onRecordingStarted());
        }

        @Override
        public void onCaptureStopped() {
            Log.i(TAG, "recordingStopped");
            synchronized (lock) {
                if (suppressDraftCaptureStopped) {
                    suppressDraftCaptureStopped = false;
                    return;
                }
            }
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
            synchronized (lock) {
                playbackDrainGate.onPlaybackStarted();
                if (lifecycleTrace != null) {
                    lifecycleTrace.playbackStarted();
                }
            }
        }

        @Override
        public void onPlaybackStopped(boolean drained) {
            String drainedTurnId = "";
            synchronized (lock) {
                boolean deliverDeviceCompletion = playbackDrainGate.onPlaybackStopped(drained);
                if (deliverDeviceCompletion) {
                    drainedTurnId = pendingDeviceAudioDoneTurnId;
                }
                pendingDeviceAudioDoneTurnId = "";
                assistantAudioStarted = false;
                lifecyclePlaybackStopped = true;
                lifecyclePlaybackDrainConfirmed = drained;
                if (lifecycleTrace != null) {
                    if (lifecyclePlaybackDrainConfirmed) {
                        lifecyclePlaybackCompleted = true;
                        lifecycleTrace.playbackCompleted();
                    }
                    if (!pendingLifecycleCompletionStatus.isEmpty()
                            && lifecyclePlaybackDrainConfirmed) {
                        lifecycleTrace.completed(
                                pendingLifecycleCompletionStatus,
                                pendingLifecycleTtsExpected,
                                pendingLifecycleAudioReceived);
                        pendingLifecycleCompletionStatus = "";
                    } else if (!pendingLifecycleCompletionStatus.isEmpty()) {
                        lifecycleTrace.failed("playback incomplete");
                        pendingLifecycleCompletionStatus = "";
                    }
                }
            }
            post(MoaStreamingVoiceSessionController.this::cancelPlaybackFrames);
            if (!drainedTurnId.isEmpty()) {
                finishDeviceAudioDone(drainedTurnId, playbackController);
            }
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
                if (wasActive && lifecycleTrace != null) {
                    lifecycleTrace.failed("socket closed");
                }
                active = false;
                assistantOutputState.suppressSpeech();
                committed = false;
                loggedVoiceActivity = false;
                sessionReady = false;
                pendingCommitAfterSessionReady = false;
                assistantAudioProgress.reset();
                clearPendingAudioLocked();
                capturedAudioBytes = 0;
                recordingStartedAtMs = 0;
                lastVoiceActivityAtMs = 0;
            }
            mainHandler.removeCallbacks(autoCommitCheck);
            mainHandler.removeCallbacks(pendingCommitTimeout);
            mainHandler.removeCallbacks(draftReadyTimeout);
            mainHandler.removeCallbacks(draftControlTimeout);
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
                playbackDrainGeneration++;
                assistantOutputState.suppressSpeech();
                committed = false;
                assistantAudioStarted = false;
                loggedVoiceActivity = false;
                sessionReady = false;
                pendingCommitAfterSessionReady = false;
                assistantAudioProgress.reset();
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
            handleVoiceDraftEvent(event);
        }

        @Override
        public void onSessionReady(String readySessionId) {
            MoaVoiceGatewaySocket socket;
            String currentTurnId;
            boolean shouldFinishCommit;
            boolean hasAudio;
            synchronized (lock) {
                if (voiceDraftEnabled && voiceDraftId.isEmpty()) {
                    reportError("Gateway did not acknowledge exact voice draft authority.", null);
                    return;
                }
                socket = gatewaySocket;
                currentTurnId = turnId;
                shouldFinishCommit = active && committed && pendingCommitAfterSessionReady;
                pendingCommitAfterSessionReady = false;
                hasAudio = capturedAudioBytes > 0;
            }
            mainHandler.removeCallbacks(pendingCommitTimeout);
            Log.i(TAG, "sessionReady");
            synchronized (lock) {
                if (lifecycleTrace != null) {
                    lifecycleTrace.sessionReady();
                }
            }
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
            synchronized (lock) {
                if (lifecycleTrace != null) {
                    lifecycleTrace.transcriptPartialReceived();
                }
            }
            post(() -> callback.onTranscriptPartial(transcriptTurnId, text));
        }

        @Override
        public void onTranscriptFinal(String transcriptTurnId, String text) {
            Log.i(TAG, "transcriptFinal chars=" + safe(text).length());
            synchronized (lock) {
                if (lifecycleTrace != null) {
                    lifecycleTrace.resultReceived("transcript");
                }
            }
            post(() -> callback.onTranscriptFinal(transcriptTurnId, text));
        }

        @Override
        public void onAssistantText(String assistantTurnId, String text) {
            synchronized (lock) {
                if (!assistantOutputState.allowsText(assistantTurnId)) {
                    return;
                }
            }
            Log.i(TAG, "assistantText chars=" + safe(text).length());
            synchronized (lock) {
                if (lifecycleTrace != null) {
                    lifecycleTrace.resultReceived("assistant_text");
                }
            }
            post(() -> callback.onAssistantText(assistantTurnId, text));
        }

        @Override
        public void onAssistantAudioStart(String audioTurnId, JSONObject format, double playbackRate) {
            MoaAudioPlaybackController playback;
            synchronized (lock) {
                if (!assistantOutputState.allowsSpeech(audioTurnId)) {
                    return;
                }
                playback = playbackController;
                assistantAudioStarted = true;
                Log.i(TAG, "assistantAudioStart playbackRate=" + playbackRate);
                if (playback != null && playbackEnabled) {
                    playback.start(playbackRate);
                }
            }
            post(() -> callback.onAssistantAudioStarted(audioTurnId));
            post(MoaStreamingVoiceSessionController.this::schedulePlaybackFrame);
        }

        @Override
        public void onAssistantAudioSegment(String audioTurnId, JSONObject segment) {
            synchronized (lock) {
                if (!assistantOutputState.allowsSpeech(audioTurnId)) {
                    return;
                }
                assistantAudioProgress.onAssistantAudioSegment(segment);
            }
            // Text is retained now, but visibility is admitted only by the
            // AudioTrack playback-head frame callback above.
        }

        @Override
        public void onAssistantAudio(byte[] pcm) {
            MoaAudioPlaybackController playback;
            String currentTurnId;
            long currentPlaybackGeneration;
            synchronized (lock) {
                playback = playbackController;
                currentTurnId = turnId;
                currentPlaybackGeneration = playbackDrainGeneration;
                if (!assistantOutputState.allowsSpeech(currentTurnId)) {
                    return;
                }
            }
            MoaPcmPlaybackQueue.OfferResult offerResult =
                    playbackEnabled && playback != null
                            ? playback.enqueue(pcm)
                            : MoaPcmPlaybackQueue.OfferResult.CLOSED;
            boolean admitted = false;
            synchronized (lock) {
                if (offerResult == MoaPcmPlaybackQueue.OfferResult.ACCEPTED
                        && playback == playbackController
                        && currentPlaybackGeneration == playbackDrainGeneration
                        && assistantOutputState.allowsSpeech(currentTurnId)) {
                    assistantAudioProgress.onAssistantAudioFrame(pcm);
                    admitted = true;
                } else if (playback == playbackController
                        && currentPlaybackGeneration == playbackDrainGeneration) {
                    assistantAudioProgress.onAssistantAudioFrameRejected();
                }
                if (admitted && !lifecycleAudioReceived && pcm != null && pcm.length > 0) {
                    lifecycleAudioReceived = true;
                    if (lifecycleTrace != null) {
                        lifecycleTrace.resultReceived("assistant_audio");
                    }
                }
            }
            if (admitted) {
                // This callback now means accepted for device playback, not just
                // received from the network. It remains prompt because enqueue
                // does not perform a blocking AudioTrack.write().
                post(() -> callback.onAssistantAudioChunk(currentTurnId));
            }
        }

        @Override
        public void onAssistantAudioDone(String audioTurnId) {
            MoaAudioPlaybackController playbackToDrain;
            boolean deliverImmediately;
            long currentPlaybackGeneration;
            synchronized (lock) {
                if (!assistantOutputState.allowsSpeech(audioTurnId)) {
                    return;
                }
                playbackToDrain = playbackController;
                currentPlaybackGeneration = playbackDrainGeneration;
                assistantOutputState.suppressSpeech();
                deliverImmediately = playbackDrainGate.onProviderAudioDone(playbackEnabled);
                pendingDeviceAudioDoneTurnId = deliverImmediately ? "" : audioTurnId;
            }
            Log.i(TAG, "providerAssistantAudioDone awaitingDeviceDrain=" + !deliverImmediately);
            mainHandler.post(() -> {
                synchronized (lock) {
                    if (currentPlaybackGeneration != playbackDrainGeneration
                            || playbackToDrain != playbackController) {
                        return;
                    }
                }
                if (deliverImmediately) {
                    finishDeviceAudioDone(audioTurnId, playbackToDrain);
                } else {
                    playbackToDrain.drainAndStop(60000L);
                }
            });
        }

        @Override
        public void onTurnProgress(String progressTurnId) {
            post(() -> callback.onTurnProgress(progressTurnId));
        }

        @Override
        public void onTurnDone(String completedTurnId, String status, boolean transcriptionOnly,
                boolean ttsSpoke, String replyLanguage, JSONObject terminalEvent) {
            Log.i(TAG, "turnDone status=" + status + " transcriptionOnly=" + transcriptionOnly + " ttsSpoke=" + ttsSpoke);
            handleTurnDone(completedTurnId, status, transcriptionOnly, ttsSpoke, replyLanguage, terminalEvent);
        }

        @Override
        public void onTtsRetryDone(String completedTurnId, String retryId, String status,
                int fromTextChar, String error) {
            post(() -> callback.onTtsRetryDone(completedTurnId, retryId, status, fromTextChar, error));
        }

        @Override
        public void onGatewayError(String message) {
            reportError(message, null);
        }
    }

    private void finishDeviceAudioDone(String audioTurnId, MoaAudioPlaybackController playback) {
        MoaAssistantAudioProgressTracker.PlaybackProgress finalProgress;
        synchronized (lock) {
            finalProgress = assistantAudioProgress.snapshot(
                    playback != null ? playback.playedPcmFrames() : 0L);
            if (playbackController == playback) {
                assistantAudioStarted = false;
            }
        }
        maybeSendFinalPlaybackProgress(gatewaySocket, audioTurnId, finalProgress, "playback_done");
        Log.i(TAG, "deviceAssistantAudioDone");
        post(() -> callback.onAssistantAudioDone(audioTurnId));
    }

}

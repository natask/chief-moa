package ai.moa.assistant;

import static ai.moa.assistant.MoaStrings.cleanError;
import static ai.moa.assistant.MoaStrings.safe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.ActionMode;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class OverlayService extends Service {
    private static final String TAG = "MoaOverlay";

    static final String ACTION_ASSIST_BUTTON = "ai.moa.assistant.action.ASSIST_BUTTON";
    static final String ACTION_COLLAPSE_SURFACES = "ai.moa.assistant.action.COLLAPSE_SURFACES";
    static final String ACTION_HIDE_OVERLAY = "ai.moa.assistant.action.HIDE_OVERLAY";
    static final String ACTION_REFRESH_ORB_SCALE = "ai.moa.assistant.REFRESH_ORB_SCALE";
    static final String ACTION_QA_STATE = "ai.moa.assistant.debug.QA_STATE_INTERNAL";
    static final String EXTRA_QA_STATE = "qa_state";
    static final String EXTRA_QA_TEXT = "qa_text";
    static final String EXTRA_START_VOICE = "ai.moa.assistant.extra.START_VOICE";

    private static final int MAX_HISTORY_MESSAGES = 50;
    private static final int MAX_GATEWAY_MESSAGES = 24;
    private static final int MAX_AGENT_PROMPT_CHARS = 12000;
    private static final int ORB_EDGE_MARGIN_DP = 16;
    private static final int OVERLAY_NOTIFICATION_ID = 5701;
    private static final long VOICE_RESPONSE_HOLD_MS = 1200;
    private static final long VOICE_NOT_SPOKEN_HOLD_MS = 5000;
    private static final String NOT_SPOKEN_SUFFIX = "\n\n(not spoken)";
    private static final long STREAMING_TURN_WATCHDOG_MS = 30000;
    // Hands-free capture re-arms the microphone this long after a turn ends, with
    // no new tap or hold. The bounds on how long that may go on for —
    // MAX_SILENT_TURNS and MAX_SESSION_MS — live next door in
    // MoaContinuousCaptureLoop, which is where they are tuned and tested.
    private static final long CONTINUOUS_VOICE_RESTART_MS = 420;
    private static final long DEVICE_CLIENT_POLL_MS = 2500;
    private static final String OVERLAY_CHANNEL_ID = "moa_overlay";
    private static final int AUDIO_NOTE_BYTES_PER_SECOND =
            MoaAudioCaptureController.SAMPLE_RATE_HZ * 2 * MoaAudioCaptureController.CHANNEL_COUNT;
    private static final int AUDIO_NOTE_MAX_BYTES = AUDIO_NOTE_BYTES_PER_SECOND * 300;
    private static final String AUDIO_NOTE_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<ChatMessage> messages = new ArrayList<>();
    private static final MoaOverlayOwner OVERLAY_OWNER = new MoaOverlayOwner();
    private MoaActionBroker actionBroker;
    private WindowManager windowManager;
    private OrbView orbView;
    private WindowManager.LayoutParams orbParams;
    private MoaCompactOverlayRoot compactOverlayRoot;
    private MoaFrameCoalescer orbDragFrameCoalescer;
    private final MoaOverlayDragMode overlayDragMode = new MoaOverlayDragMode();
    private final MoaWindowLayoutState orbDragLayoutState = new MoaWindowLayoutState();
    private View orbRemoveTarget;
    private View orbRemovalUndoChip;
    private final MoaOrbRemovalUndo orbRemovalUndo = new MoaOrbRemovalUndo();
    private Runnable pendingOrbRemovalCommit;
    private int orbDragStartX;
    private int orbDragStartY;
    private int orbDragCommittedX;
    private int orbDragCommittedY;
    private boolean orbRemoveTargetActive;
    private int orbDragScreenWidth;
    private int orbDragScreenHeight;
    // The composer panel — the typed-chat surface — is its own window and its own
    // controller. It is deliberately not part of the overlay unit.
    private final MoaComposerPanelController composerPanel =
            new MoaComposerPanelController(composerPanelHost());
    // The overlay unit: companion between two ribbons, owned by its own
    // controller inside one bounded WindowManager root.
    private final MoaOverlayUnitController overlayUnit =
            new MoaOverlayUnitController(overlayUnitHost());
    private TextView voiceCancelControl;
    private TextView voiceSendControl;
    private WindowManager.LayoutParams voiceCancelControlParams;
    private WindowManager.LayoutParams voiceSendControlParams;
    private VoiceRuntimeState voiceRuntimeState = VoiceRuntimeState.READY;
    private AlertDialog toolConfirmationDialog;
    private final MoaToolRequestGate toolRequestGate = new MoaToolRequestGate();
    private MoaToolReceiptOutbox toolReceiptOutbox;
    private MoaToolReceiptOutbox.Reservation activeToolReservation;
    private String activeToolName = "";
    private static final int MAX_VOICE_TRANSCRIPT_ENTRIES = 20;
    private final MoaVoiceTranscriptLog voiceLog =
            new MoaVoiceTranscriptLog(MAX_VOICE_TRANSCRIPT_ENTRIES);
    private String voiceUserTranscript = "";
    private String voiceAssistantTranscript = "";
    private boolean voiceUserTranscriptFinal;
    private final MoaLiveConversationState liveConversation = new MoaLiveConversationState();
    private boolean currentStreamingAssistantRecorded;
    private String sessionSpeakLanguage = "";
    private String sessionHearLanguages = "";
    private Runnable pendingAutoDismiss;
    private Runnable pendingContinuousVoiceRestart;
    private Runnable pendingStreamingTurnWatchdog;
    private final MoaVoiceFailureRetry voiceFailureRetry = new MoaVoiceFailureRetry();
    private boolean streamingTurnAutoCommit;
    private boolean streamingTurnContinuous;
    private boolean streamingTurnRetried;
    private MoaVoiceController voiceController;
    private MoaStreamingVoiceSessionController streamingVoiceController;
    private String pendingReplacementTurnId = "";
    private boolean nextVoiceCaptureFreshThread;
    private MoaVoiceSamplePlayer voiceSamplePlayer;
    private boolean nextVoiceRunsAgent;
    private static volatile boolean running;
    private String gatewayUrl = "";
    private String gatewayToken = "";
    private String conversationId = "";
    private String activeBranchId = "default";
    private boolean currentStreamingTurnRouted;
    private boolean currentStreamingTurnCommitRequested;
    private String currentStreamingTranscript = "";
    private final MoaSpeechTranscriptAccumulator streamingTranscriptAccumulator = new MoaSpeechTranscriptAccumulator();
    private final MoaAgentRunTracker agentRuns = new MoaAgentRunTracker();
    private boolean agentRunPolling;
    private String nextManualVoiceFollowUpRunId = "";
    private String nextStreamingVoiceFollowUpRunId = "";
    private int streamingVoiceGeneration;
    private boolean continuousVoiceLoop;
    private final MoaContinuousCaptureLoop captureLoop =
            new MoaContinuousCaptureLoop(continuousCaptureSink());
    private boolean voiceInvocationLatched;
    private boolean suppressFirstTapTurnEmptyCue;
    private boolean pushToTalkVoiceTurn;
    private final MoaPushToTalkFinish pushToTalkFinish = new MoaPushToTalkFinish();
    private boolean forcedReviewableVoiceDraft;
    private boolean recordModeEnabled;
    private MoaVoiceFirstTapResolver.CaptureOrigin manualTapCaptureOrigin =
            MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
    private boolean audioNoteActive;
    private MoaAudioCaptureController audioNoteCapture;
    private ByteArrayOutputStream audioNoteBuffer;
    private MoaAudioCaptureController warmMic;
    private final MoaContextControlState contextControls = new MoaContextControlState();
    private boolean streamingTurnIncognito;
    private int streamingSwitchToken;
    private boolean streamingBranchSwitchPending;
    private boolean streamingCommitPendingOpen;
    private boolean pendingContinuousVoiceRestartAfterAudio;
    private boolean streamingAssistantAudioPlaying;
    private boolean currentStreamingTurnAudioReceived;
    private final MoaTtsRecoveryQueue ttsRecoveryQueue = new MoaTtsRecoveryQueue();
    private boolean deviceClientLoopRunning;
    private boolean deviceClientPollInFlight;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        actionBroker = new MoaActionBroker(this);
        toolReceiptOutbox = new MoaToolReceiptOutbox(this);
        voiceController = new MoaVoiceController(this, new MoaVoiceController.Callback() {
            @Override
            public void onVoiceStateChanged() {
                updateMicState();
            }
            @Override
            public void onShowPanelRequested() {
                showTranscriptOverlay("");
                setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
            }
            @Override
            public void onAssistantMessage(String text) {
                addMessage(true, text);
                updateVoiceAssistantTranscript(text);
            }
            @Override
            public void onShowTranscript(String text) {
                showTranscriptOverlay(text);
                updateVoiceUserTranscript(text, false);
                setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
            }
            @Override
            public void onUpdateTranscript(String text) {
                updateVoiceUserTranscript(text, false);
                setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
            }
            @Override
            public void onRemoveTranscript() {
                removeTranscriptOverlay();
            }
            @Override
            public void onComposerText(String text) {
                setComposerText(text);
            }
            @Override
            public void onVoiceTurn(String text) {
                sendUserMessage(text, true);
            }
            @Override
            public void onSpokenReplyFinished() {
                completeVoiceReplyPlayback();
            }
        });
        loadSettings();
        refreshVoiceProfile();
        MoaPrefs.setHistoryJson(this, "");
        promoteToForeground();
        MoaUpdateNotifier.checkAsync(this, gatewayUrl, gatewayToken);
        showOrb();
        startDeviceClientLoop();
        adoptSharedSessionId();
    }

    private void adoptSharedSessionId() {
        if (gatewayUrl.isEmpty()) {
            return;
        }
        final String url = gatewayUrl;
        final String token = gatewayToken;
        new Thread(() -> {
            try {
                String sharedId = new MoaGatewayClient(url, token).defaultSessionId();
                if (safe(sharedId).isEmpty()) {
                    return;
                }
                mainHandler.post(() -> {
                    if (!sharedId.equals(conversationId)) {
                        conversationId = sharedId;
                        MoaPrefs.setConversationId(this, sharedId);
                        activeBranchId = MoaPrefs.conversationBranchId(this, sharedId);
                    }
                });
            } catch (Exception ignored) {
            }
        }, "moa-shared-session").start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        loadSettings();
        Log.i(TAG, "onStartCommand id=" + startId
                + " action=" + (intent == null ? "" : intent.getAction())
                + " voiceInvocation=" + isVoiceInvocation(intent));
        if (!Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_HIDE_OVERLAY.equals(intent != null ? intent.getAction() : null)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (orbView == null) {
            showOrb();
        }
        if (BuildConfig.DEBUG && ACTION_QA_STATE.equals(intent != null ? intent.getAction() : null)) {
            applyQaState(intent);
            return START_STICKY;
        }
        if (ACTION_REFRESH_ORB_SCALE.equals(intent != null ? intent.getAction() : null)) {
            applyOrbScale();
            return START_STICKY;
        }
        if (ACTION_COLLAPSE_SURFACES.equals(intent != null ? intent.getAction() : null)) {
            collapseInteractiveSurfaces();
            return START_STICKY;
        }
        if (isVoiceInvocation(intent)) {
            mainHandler.post(this::handleVoiceInvocation);
        }
        return START_STICKY;
    }

    /** Only reachable through the receiver compiled into debug APKs. */
    private void applyQaState(Intent intent) {
        String state = safe(intent.getStringExtra(EXTRA_QA_STATE));
        String text = safe(intent.getStringExtra(EXTRA_QA_TEXT));
        if ("reset".equals(state)) {
            resetVoiceTurnTranscript();
            removeTranscriptOverlay();
        } else if ("partial".equals(state)) {
            showTranscriptOverlay(text);
            updateVoiceUserTranscript(text, false);
        } else if ("final".equals(state)) {
            showTranscriptOverlay(text);
            updateVoiceUserTranscript(text, true);
        }
        mainHandler.postDelayed(this::recordQaOverlayState, 350);
        Log.i(TAG, "qa_state_applied state=" + state + " chars=" + text.length());
    }

    private void recordQaOverlayState() {
        if (!BuildConfig.DEBUG) return;
        Rect bounds = overlayUnit.qaYouBounds();
        getSharedPreferences("moa_qa", MODE_PRIVATE).edit()
                .putInt("left", bounds.left).putInt("top", bounds.top)
                .putInt("right", bounds.right).putInt("bottom", bounds.bottom)
                .putBoolean("expanded", overlayUnit.qaYouExpanded())
                .putLong("observed_at", System.currentTimeMillis()).apply();
    }

    @Override
    public void onDestroy() {
        String pendingToolRequest = toolRequestGate.active();
        if (!pendingToolRequest.isEmpty()) finishClaimedToolRequest(pendingToolRequest,
                new MoaToolRequestExecution(false, "Overlay stopped before the local action completed.", null));
        running = false;
        MoaAccessibilityService.cancelActiveYoutubeOperation();
        if (toolConfirmationDialog != null) toolConfirmationDialog.dismiss();
        toolConfirmationDialog = null;
        cancelAudioNoteCapture();
        discardWarmMic();
        cancelStreamingTurnWatchdog();
        voiceLog.clear();
        removeTranscriptOverlay();
        removeVoiceDraftControls();
        removePanel();
        removeOrbRemoveTarget();
        if (orbDragFrameCoalescer != null) {
            orbDragFrameCoalescer.cancel();
            orbDragFrameCoalescer = null;
        }
        removeOrb();
        agentRunPolling = false;
        cancelStreamingTurnWatchdog();
        if (voiceController != null) {
            voiceController.destroy();
            voiceController = null;
        }
        if (streamingVoiceController != null) {
            streamingVoiceController.destroy();
            streamingVoiceController = null;
        }
        if (voiceSamplePlayer != null) {
            voiceSamplePlayer.destroy();
            voiceSamplePlayer = null;
        }
        deviceClientLoopRunning = false;
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        overlayUnit.onConfigurationChanged();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static boolean isRunning() {
        return running;
    }

    private void promoteToForeground() {
        createOverlayNotificationChannel();
        Notification notification = overlayNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int foregroundTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                foregroundTypes |= ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            }
            startForeground(OVERLAY_NOTIFICATION_ID, notification, foregroundTypes);
            return;
        }
        startForeground(OVERLAY_NOTIFICATION_ID, notification);
    }

    private void createOverlayNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                OVERLAY_CHANNEL_ID,
                "AG overlay",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the AG overlay available above other apps.");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private Notification overlayNotification() {
        Intent intent = MoaAssistantLaunchCoordinator.assistActivityIntent(
                this, MoaAssistantLaunchCoordinator.SOURCE_NOTIFICATION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);
        Intent hideIntent = new Intent(this, OverlayService.class).setAction(ACTION_HIDE_OVERLAY);
        PendingIntent hidePendingIntent = PendingIntent.getService(this, 1, hideIntent, flags);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, OVERLAY_CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setSmallIcon(R.drawable.ic_moa_orb)
                .setContentTitle("AG overlay")
                .setContentText("Ready for commands on the current screen.")
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setDefaults(0);
        builder.addAction(R.drawable.ic_moa_orb, "Hide", hidePendingIntent);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setCategory(Notification.CATEGORY_SERVICE);
            builder.setColor(0xFFF4D35E);
        }
        return builder.build();
    }

    private void loadSettings() {
        gatewayUrl = safe(MoaPrefs.gatewayUrl(this));
        gatewayToken = safe(MoaPrefs.gatewayToken(this));
        conversationId = MoaPrefs.conversationId(this);
        activeBranchId = MoaPrefs.conversationBranchId(this, conversationId);
        applyCachedVoiceProfile();
    }

    private void applyCachedVoiceProfile() {
        if (voiceController != null) {
            voiceController.setLanguageTags(MoaPrefs.inputLanguageTag(this), MoaPrefs.replyLanguageTag(this));
        }
        applyCachedPetVisualState();
        updateVoiceHeaderState();
    }

    private void applyCachedPetVisualState() {
        if (orbView != null) {
            orbView.setPetVisualState(MoaPrefs.petVisualState(this));
        }
    }

    private void refreshVoiceProfile() {
        if (gatewayUrl.isEmpty()) {
            return;
        }
        final String url = gatewayUrl;
        final String token = gatewayToken;
        final String deviceId = androidDeviceId();
        new Thread(() -> {
            String profileJson = "";
            String companionJson = "";
            boolean companionFetched = false;
            boolean refreshFailed = false;
            try {
                MoaGatewayClient client = new MoaGatewayClient(url, token);
                JSONObject payload = client.agentProfile("device", deviceId);
                JSONObject profile = payload.optJSONObject("profile");
                if (profile != null) {
                    profileJson = profile.toString();
                }
                try {
                    JSONObject companion = client.activeCompanionPet("device", deviceId);
                    if (companion != null) {
                        companionJson = companion.toString();
                        companionFetched = true;
                    }
                } catch (Exception ignored) {
                    refreshFailed = true;
                }
            } catch (Exception ignored) {
                // Profile refresh is best-effort; cached/default language still works.
                refreshFailed = true;
            }
            final String nextProfileJson = profileJson;
            final String nextCompanionJson = companionJson;
            final boolean nextCompanionFetched = companionFetched;
            final boolean nextRefreshFailed = refreshFailed;
            mainHandler.post(() -> {
                if (!nextProfileJson.isEmpty()) {
                    MoaPrefs.setAgentProfileJson(this, nextProfileJson);
                }
                if (nextCompanionFetched) {
                    MoaPrefs.setActiveCompanionJson(this, nextCompanionJson);
                } else if (nextRefreshFailed) {
                    MoaPrefs.setActiveCompanionStale(this, true);
                }
                if (!nextProfileJson.isEmpty() || nextCompanionFetched || nextRefreshFailed) {
                    applyCachedVoiceProfile();
                    updateAgentRunStatus();
                }
            });
        }, "moa-voice-profile").start();
    }

    private void addMessage(boolean assistant, String text) {
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        messages.add(new ChatMessage(assistant, text.trim()));
        trimHistory();
        renderMessages();
    }

    private void trimHistory() {
        while (messages.size() > MAX_HISTORY_MESSAGES) {
            messages.remove(0);
        }
    }

    private void showOrb() {
        if (!Settings.canDrawOverlays(this) || orbView != null || !OVERLAY_OWNER.claim(this)) {
            return;
        }
        int size = scaledOrbSizePx();
        orbView = new OrbView(this);
        applyCachedPetVisualState();
        orbParams = MoaOrbWindowSizing.initialParams(
                this, size, MoaOverlayWindowType.resolve(), ORB_EDGE_MARGIN_DP);
        compactOverlayRoot = new MoaCompactOverlayRoot(
                this, windowManager, MoaOverlayWindowType.resolve());
        orbDragFrameCoalescer = new MoaFrameCoalescer(
                new MoaViewFrameScheduler(orbView), this::applyLatestOrbDragFrame);
        orbView.setOnTouchListener(new MoaOrbTouchListener(
                this,
                orbParams,
                size,
                ORB_EDGE_MARGIN_DP,
                this::handleOrbSingleTap, this::handleOrbDoublePressStart,
                this::handleOrbVoicePressRelease, this::beginWarmMic,
                this::discardWarmMic,
                () -> MoaPrefs.voiceFirstGestures(this) || voiceInvocationLatched
                        || reviewableVoiceDraftActive(),
                this::manualTapCaptureOrigin,
                this::handleOrbStartTalkLoop, this::handleOrbStopAndSend,
                this::handleOrbStartFreshTalkLoop, this::handleOrbCancelTalkLoop,
                this::showPanel, this::handleOrbPushToTalkCancel,
                this::showOrbRemoveTarget, this::updateOrbDragSurfaces,
                this::finishOrbDrag
        ));
        orbView.setAlpha(MoaOrbPresentation.IDLE_ALPHA);
        compactOverlayRoot.put(orbView, orbScreenBounds(), true);
        compactOverlayRoot.attach();
        compactOverlayRoot.commitFrame();
    }

    private int scaledOrbSizePx() {
        return dp(MoaOrbPresentation.scaledWindowDp(MoaPrefs.orbScalePercent(this)));
    }

    private Rect orbScreenBounds() {
        int size = orbParams != null && orbParams.width > 0
                ? orbParams.width : scaledOrbSizePx();
        int x = orbParams == null ? 0 : orbParams.x;
        int y = orbParams == null ? 0 : orbParams.y;
        return new Rect(x, y, x + size, y + size);
    }

    private void syncOrbSlot() {
        if (compactOverlayRoot != null && orbView != null) {
            compactOverlayRoot.put(orbView, orbScreenBounds(), true);
        }
    }

    private void applyOrbScale() {
        if (orbView == null || orbParams == null) {
            showOrb();
            return;
        }
        int size = scaledOrbSizePx();
        orbParams.width = size;
        orbParams.height = size;
        int margin = dp(ORB_EDGE_MARGIN_DP);
        orbParams.x = MoaOrbPresentation.clampWindowPosition(
                orbParams.x, getResources().getDisplayMetrics().widthPixels, size, margin);
        orbParams.y = MoaOrbPresentation.clampWindowPosition(
                orbParams.y, getResources().getDisplayMetrics().heightPixels, size, margin);
        syncOrbSlot();
        compactOverlayRoot.commitFrame();
        updateAnchoredSurfacePositions();
    }

    private void removeOrb() {
        if (orbView != null) {
            if (compactOverlayRoot != null) compactOverlayRoot.removeSlot(orbView);
            orbView = null;
        }
        if (compactOverlayRoot != null) {
            compactOverlayRoot.detach();
            compactOverlayRoot = null;
        }
        OVERLAY_OWNER.release(this);
    }

    private void positionSurfaceNearOrb(View surface, WindowManager.LayoutParams params) {
        if (surface == null || params == null || orbParams == null) {
            return;
        }
        int screenWidth = getResources().getDisplayMetrics().widthPixels;
        int screenHeight = getResources().getDisplayMetrics().heightPixels;
        int margin = dp(10);
        int orbSize = orbParams.width > 0 ? orbParams.width : scaledOrbSizePx();
        int surfaceWidth = params.width > 0 ? params.width : Math.min(screenWidth - margin * 2, dp(380));
        MoaOverlayWindowLayout.positionAnchored(
                windowManager, surface, params, screenWidth, screenHeight, margin, dp(12),
                orbView, orbParams, orbSize, surfaceWidth,
                surface == composerPanel.view() ? dp(430) : dp(180));
    }

    // The card is always wholly above the orb, so a card that grows (streamed
    // reply, appended transcript rows) must be re-anchored on every remeasure —
    // otherwise a TOP-gravity window would expand downward over the orb.
    private void keepSurfaceAnchoredOnRemeasure(View surface) {
        surface.addOnLayoutChangeListener((v, left, top, right, bottom,
                                           oldLeft, oldTop, oldRight, oldBottom) -> {
            if (bottom - top == oldBottom - oldTop) {
                return;
            }
            mainHandler.post(() -> {
                if (v == composerPanel.view()) {
                    if (overlayDragMode.isDragging()) {
                        return;
                    }
                    positionSurfaceNearOrb(composerPanel.view(), composerPanel.params());
                }
            });
        });
    }
    private MoaComposerPanelController.Host composerPanelHost() {
        return new MoaComposerPanelController.Host() {
            @Override
            public android.content.Context context() {
                return OverlayService.this;
            }

            @Override
            public WindowManager windowManager() {
                return windowManager;
            }

            @Override
            public int overlayType() {
                return MoaOverlayWindowType.resolve();
            }

            @Override
            public void positionNearCompanion(View surface, WindowManager.LayoutParams params) {
                positionSurfaceNearOrb(surface, params);
            }

            @Override
            public void keepAnchoredOnRemeasure(View surface) {
                keepSurfaceAnchoredOnRemeasure(surface);
            }

            @Override
            public void attachHeaderDrag(View header) {
                attachSurfaceHeaderDrag(header);
            }

            @Override
            public void onOutsideTouch() {
                dismissOverlayUi();
            }

            @Override
            public void onHideOverlay() {
                stopSelf();
            }

            @Override
            public void onClosePanel() {
                dismissOverlayUi();
            }

            @Override
            public void onSend(String text) {
                sendUserMessage(text, false);
            }

            @Override
            public void onToggleRecordMode() {
                toggleRecordMode();
            }

            @Override
            public boolean recordModeEnabled() {
                return recordModeEnabled;
            }

            @Override
            public MoaContextControlState contextControls() {
                return contextControls;
            }

            @Override
            public void onContextControlsChanged() {
                refreshContextControls();
            }

            @Override
            public String headerStatusText() {
                return overlayHeaderStatusText();
            }

            @Override
            public String gestureHint() {
                return orbGestureHint();
            }

            @Override
            public List<ChatMessage> messages() {
                return messages;
            }
        };
    }

    private void togglePanel() {
        composerPanel.toggle();
    }

    private void showPanel() {
        if (!Settings.canDrawOverlays(this) || composerPanel.isOpen()) {
            return;
        }
        removeTranscriptOverlay();
        loadSettings();
        composerPanel.show();
    }

    private void removePanel() {
        composerPanel.remove();
    }

    private void hideKeyboard() {
        composerPanel.hideKeyboard();
    }

    private void renderMessages() {
        composerPanel.renderMessages();
    }

    private void refreshContextControls() {
        composerPanel.refreshContextControls();
    }

    private void refreshRecordModePill() {
        composerPanel.refreshRecordModePill();
    }

    private void setComposerText(String text) {
        composerPanel.setComposerText(text);
    }

    private void updateAnchoredSurfacePositions() {
        applyLatestOrbDragFrame();
    }

    private void attachSurfaceHeaderDrag(View header) {
        if (header == null || orbView == null || orbParams == null) return;
        header.setOnTouchListener(new MoaOverlayGroupDragListener(
                this, orbParams, scaledOrbSizePx(), dp(ORB_EDGE_MARGIN_DP),
                this::hideKeyboard, this::updateOrbDragSurfaces));
    }

    private void showOrbRemoveTarget() {
        orbDragStartX = orbParams == null ? 0 : orbParams.x;
        orbDragStartY = orbParams == null ? 0 : orbParams.y;
        orbDragCommittedX = orbDragStartX;
        orbDragCommittedY = orbDragStartY;
        boolean beganDrag = overlayDragMode.begin();
        overlayUnit.setDragging(true);
        if (beganDrag) {
            orbDragScreenWidth = getResources().getDisplayMetrics().widthPixels;
            orbDragScreenHeight = getResources().getDisplayMetrics().heightPixels;
            orbDragLayoutState.reset();
            setDragDependentControlsHidden(true);
        }
        // Speech owns the compact unit until the user explicitly finishes it.
        // Dragging may reposition that unit, but must never offer a second,
        // accidental exit affordance while microphone capture is active.
        if (speechCaptureOwnsOverlay() || orbRemoveTarget != null
                || !Settings.canDrawOverlays(this)) {
            return;
        }
        orbRemoveTarget = MoaOrbRemoveTarget.show(
                this, windowManager, MoaOverlayWindowType.resolve());
    }

    private boolean speechCaptureOwnsOverlay() {
        return pushToTalkVoiceTurn
                || audioNoteActive
                || continuousVoiceLoop
                || pendingContinuousVoiceRestart != null
                || streamingVoiceActive()
                || voiceController.isActive();
    }
    private void updateOrbDragSurfaces() {
        if (orbDragFrameCoalescer != null) {
            orbDragFrameCoalescer.request();
        }
    }

    private void applyLatestOrbDragFrame() {
        if (orbView == null || orbParams == null) {
            return;
        }
        MoaOverlayDragMode.FramePlan plan = overlayDragMode.movingFrame();
        if (!plan.submitDependents) {
            if (orbDragLayoutState.changed(orbParams)) {
                compactOverlayRoot.translateSlots(
                        orbParams.x - orbDragCommittedX,
                        orbParams.y - orbDragCommittedY);
                orbDragCommittedX = orbParams.x;
                orbDragCommittedY = orbParams.y;
                syncOrbSlot();
                compactOverlayRoot.commitFrame();
            }
            updateOrbRemoveTargetState();
            return;
        }
        // Anchor the composer FIRST: its always-above rule may push the orb down,
        // and the draft controls and orb window below must lay out from that
        // settled position so the whole ensemble moves as one frame. The ribbons
        // never move the companion; they flip instead.
        if (composerPanel.view() != null) {
            positionSurfaceNearOrb(composerPanel.view(), composerPanel.params());
        }
        prepareVoiceDraftControlPositions();
        syncOrbSlot();
        overlayUnit.preparePosition();
        prepareVoiceDraftControlSlots();
        compactOverlayRoot.commitFrame();
        updateOrbRemoveTargetState();
    }

    private MoaOrbOverlayGeometry.Bounds removeTargetBounds() {
        return MoaOrbOverlayGeometry.removeTargetBounds(
                orbDragScreenWidth > 0 ? orbDragScreenWidth
                        : getResources().getDisplayMetrics().widthPixels,
                orbDragScreenHeight > 0 ? orbDragScreenHeight
                        : getResources().getDisplayMetrics().heightPixels,
                dp(MoaOrbRemoveTarget.WIDTH_DP),
                dp(MoaOrbRemoveTarget.HEIGHT_DP),
                dp(MoaOrbRemoveTarget.BOTTOM_INSET_DP));
    }

    private void updateOrbRemoveTargetState() {
        if (!(orbRemoveTarget instanceof TextView) || orbParams == null) {
            return;
        }
        int orbSize = orbParams.width > 0 ? orbParams.width : scaledOrbSizePx();
        // The armed zone is the PAINTED target plus one tolerance, not the old
        // 270x170dp invisible swath: what removes the overlay is what the user
        // can see, and the companion's centre has to be on it.
        boolean active = MoaOrbOverlayGeometry.isInRemoveTarget(
                removeTargetBounds(),
                orbParams.x,
                orbParams.y,
                orbSize,
                dp(MoaOrbRemoveTarget.TOLERANCE_DP)
        );
        if (active == orbRemoveTargetActive) {
            return;
        }
        orbRemoveTargetActive = active;
        MoaOrbRemoveTarget.update(this, (TextView) orbRemoveTarget, active);
    }
    private void finishOrbDrag(Boolean completedDrop) {
        if (orbDragFrameCoalescer != null) {
            orbDragFrameCoalescer.flush();
        }
        boolean remove = Boolean.TRUE.equals(completedDrop) && orbRemoveTargetActive;
        removeOrbRemoveTarget();
        if (overlayDragMode.finish()) {
            orbDragScreenWidth = 0;
            orbDragScreenHeight = 0;
            setDragDependentControlsHidden(false);
            overlayUnit.setDragging(false);
            // Restore and re-anchor the latest retained text/control state once.
            applyLatestOrbDragFrame();
        }
        if (remove) {
            beginReversibleOrbRemoval();
        }
    }

    private void setDragDependentControlsHidden(boolean hidden) {
        composerPanel.setHidden(hidden);
    }

    // Removal is reversible. Every window still detaches in this same call — no
    // exit animations, no posted teardown, so nothing visibly lingers — but the
    // service stays alive behind a single undo chip. Undo restores the companion
    // where the drag STARTED, not where it was dropped.
    private void beginReversibleOrbRemoval() {
        orbRemovalUndo.arm(orbDragStartX, orbDragStartY, SystemClock.uptimeMillis());
        removeAllOverlayWindowsNow();
        showOrbRemovalUndoChip();
        pendingOrbRemovalCommit = () -> {
            pendingOrbRemovalCommit = null;
            if (!orbRemovalUndo.pending(SystemClock.uptimeMillis())) {
                orbRemovalUndo.disarm();
                removeOrbRemovalUndoChip();
                stopSelf();
            }
        };
        mainHandler.postDelayed(pendingOrbRemovalCommit, MoaOrbRemovalUndo.WINDOW_MS);
    }

    private void showOrbRemovalUndoChip() {
        if (!Settings.canDrawOverlays(this) || orbRemovalUndoChip != null) {
            return;
        }
        orbRemovalUndoChip = MoaOrbRemoveTarget.undoChip(
                this, windowManager, MoaOverlayWindowType.resolve(), this::undoOrbRemoval);
    }

    private void removeOrbRemovalUndoChip() {
        View chip = orbRemovalUndoChip;
        orbRemovalUndoChip = null;
        MoaOverlayWindowLayout.detach(windowManager, chip);
    }

    private void undoOrbRemoval() {
        if (!orbRemovalUndo.consume(SystemClock.uptimeMillis())) {
            return;
        }
        if (pendingOrbRemovalCommit != null) {
            mainHandler.removeCallbacks(pendingOrbRemovalCommit);
            pendingOrbRemovalCommit = null;
        }
        removeOrbRemovalUndoChip();
        showOrb();
        if (orbParams != null) {
            orbParams.x = orbRemovalUndo.restoreX();
            orbParams.y = orbRemovalUndo.restoreY();
            syncOrbSlot();
            compactOverlayRoot.commitFrame();
        }
        updateMicState();
    }

    private void removeAllOverlayWindowsNow() {
        hideKeyboard();
        composerPanel.detachNow();
        cancelAutoDismiss();
        overlayUnit.detachNow();
        removeVoiceDraftControls();
        removeOrbRemoveTarget();
        removeOrb();
    }

    private void removeOrbRemoveTarget() {
        orbRemoveTargetActive = false;
        if (orbRemoveTarget == null) {
            return;
        }
        View target = orbRemoveTarget;
        orbRemoveTarget = null;
        MoaOverlayWindowLayout.detach(windowManager, target);
    }

    // The overlay unit — the companion between two ribbons — is owned by
    // MoaOverlayUnitController. The service keeps the voice session, the
    // composer, and the companion's own gestures, and drives the unit with the
    // current turn's text; it asks the unit nothing about how that text is
    // painted. showTranscriptOverlay/removeTranscriptOverlay keep their names
    // because the voice paths call them from about forty places.
    private void showTranscriptOverlay(String value) {
        if (!Settings.canDrawOverlays(this)) {
            return;
        }
        String initialText = visibleVoiceContent(value);
        if (!initialText.isEmpty()) {
            voiceLog.setUser(initialText, false);
            voiceUserTranscript = initialText;
            voiceUserTranscriptFinal = false;
        }
        if (!overlayUnit.isShowing()) {
            cancelAutoDismiss();
            removePanel();
            overlayUnit.show();
        }
        renderVoiceTranscriptRows();
    }

    private MoaOverlayUnitController.Host overlayUnitHost() {
        return new MoaOverlayUnitController.Host() {
            @Override
            public android.content.Context context() {
                return OverlayService.this;
            }

            @Override
            public WindowManager windowManager() {
                return windowManager;
            }

            @Override
            public MoaCompactOverlayRoot compactRoot() {
                return compactOverlayRoot;
            }

            @Override
            public int overlayType() {
                return MoaOverlayWindowType.resolve();
            }

            @Override
            public View companion() {
                return orbView;
            }

            @Override
            public WindowManager.LayoutParams companionParams() {
                return orbParams;
            }

            @Override
            public int companionSizePx() {
                return orbParams != null && orbParams.width > 0
                        ? orbParams.width : scaledOrbSizePx();
            }

            @Override
            public void onDragStart() {
                showOrbRemoveTarget();
            }

            @Override
            public void onDragMove(int dx, int dy) {
                dragUnitBy(dx, dy);
            }

            @Override
            public void onDragEnd(boolean committed) {
                finishOrbDrag(committed);
            }

            @Override
            public void openHistory() {
                openHistorySurface();
            }

            @Override
            public void hideOverlay() {
                stopSelf();
            }

            @Override
            public boolean assistantSpeaking() {
                return streamingAssistantAudioPlaying;
            }

            @Override
            public boolean retryAvailable() {
                return voiceFailureRetry.isAvailable(streamingVoiceGeneration);
            }

            @Override
            public void stopSpeaking() {
                stopAssistantAudioForBargeIn();
            }

            @Override
            public void retryCapture() {
                retryFailedVoiceCapture();
            }

            @Override
            public void onWentDormant() {
                removeTranscriptOverlay();
            }
        };
    }

    private void dragUnitBy(int dx, int dy) {
        if (orbParams == null) {
            return;
        }
        int size = orbParams.width > 0 ? orbParams.width : scaledOrbSizePx();
        int margin = dp(ORB_EDGE_MARGIN_DP);
        orbParams.x = MoaRibbonUnitLayout.dragCompanionX(
                orbDragStartX, dx,
                orbDragScreenWidth > 0 ? orbDragScreenWidth
                        : getResources().getDisplayMetrics().widthPixels,
                size, margin);
        orbParams.y = MoaRibbonUnitLayout.dragCompanionY(
                orbDragStartY, dy,
                orbDragScreenHeight > 0 ? orbDragScreenHeight
                        : getResources().getDisplayMetrics().heightPixels,
                size, margin);
        updateOrbDragSurfaces();
    }

    // History is a DIFFERENT surface. The overlay shows the current turn only and
    // never becomes a scrollback; the full app owns the session history.
    private void openHistorySurface() {
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(MainActivity.EXTRA_SHOW_HISTORY, true);
        try {
            startActivity(intent);
        } catch (Exception error) {
            Log.w(TAG, "history open failed: " + cleanError(error));
        }
    }

    private boolean reviewableVoiceDraftActive() {
        return continuousVoiceLoop
                && !pushToTalkVoiceTurn
                && !currentStreamingTurnCommitRequested
                && (voiceRuntimeState == VoiceRuntimeState.LISTENING
                    || voiceRuntimeState == VoiceRuntimeState.RECOVERING);
    }

    private void updateVoiceDraftControls() {
        boolean visible = reviewableVoiceDraftActive();
        if (!visible) {
            removeVoiceDraftControls();
            return;
        }
        showVoiceDraftControls();
        if (overlayDragMode.isDragging()) {
            setDragDependentControlsHidden(true);
            return;
        }
        updateVoiceDraftControlPositions();
    }

    private void showVoiceDraftControls() {
        if (!Settings.canDrawOverlays(this) || orbView == null) {
            return;
        }
        int size = dp(44);
        if (voiceCancelControl == null) {
            voiceCancelControl = MoaVoiceDraftControls.create(
                    this, "×", "Cancel voice draft", false, dp(42), dp(1));
            voiceCancelControl.setOnClickListener(v -> discardVoiceDraft());
            voiceCancelControlParams = MoaVoiceDraftControls.windowParams(
                    size, MoaOverlayWindowType.resolve());
            compactOverlayRoot.put(voiceCancelControl, new Rect(0, 0, size, size), true);
        }
        if (voiceSendControl == null) {
            voiceSendControl = MoaVoiceDraftControls.create(
                    this, "↑", "Send voice draft", true, dp(42), dp(1));
            voiceSendControl.setOnClickListener(v -> sendVoiceDraft());
            voiceSendControlParams = MoaVoiceDraftControls.windowParams(
                    size, MoaOverlayWindowType.resolve());
            compactOverlayRoot.put(voiceSendControl, new Rect(0, 0, size, size), true);
        }
    }

    private void updateVoiceDraftControlPositions() {
        prepareVoiceDraftControlPositions();
        syncOrbSlot();
        prepareVoiceDraftControlSlots();
        compactOverlayRoot.commitFrame();
    }

    private void prepareVoiceDraftControlPositions() {
        if (voiceCancelControl == null || voiceSendControl == null
                || voiceCancelControlParams == null || voiceSendControlParams == null
                || orbView == null || orbParams == null) {
            return;
        }
        int screenWidth = getResources().getDisplayMetrics().widthPixels;
        int screenHeight = getResources().getDisplayMetrics().heightPixels;
        int controlSize = voiceCancelControlParams.width;
        int orbSize = orbParams.width > 0 ? orbParams.width : scaledOrbSizePx();
        int gap = dp(8);
        int margin = dp(12);
        int minOrbX = margin + controlSize + gap;
        int maxOrbX = Math.max(minOrbX, screenWidth - margin - controlSize - gap - orbSize);
        int safeOrbX = Math.max(minOrbX, Math.min(orbParams.x, maxOrbX));
        orbParams.x = safeOrbX;
        int controlY = orbParams.y + (orbSize - controlSize) / 2;
        controlY = Math.max(margin, Math.min(controlY, screenHeight - controlSize - margin));
        voiceCancelControlParams.x = orbParams.x - gap - controlSize;
        voiceCancelControlParams.y = controlY;
        voiceSendControlParams.x = orbParams.x + orbSize + gap;
        voiceSendControlParams.y = controlY;
    }

    private void updatePreparedVoiceDraftControlLayouts() {
        prepareVoiceDraftControlSlots();
        compactOverlayRoot.commitFrame();
    }

    private void prepareVoiceDraftControlSlots() {
        if (compactOverlayRoot == null) return;
        if (voiceCancelControl != null && voiceCancelControlParams != null) {
            compactOverlayRoot.put(voiceCancelControl, new Rect(
                    voiceCancelControlParams.x, voiceCancelControlParams.y,
                    voiceCancelControlParams.x + voiceCancelControlParams.width,
                    voiceCancelControlParams.y + voiceCancelControlParams.height), true);
        }
        if (voiceSendControl != null && voiceSendControlParams != null) {
            compactOverlayRoot.put(voiceSendControl, new Rect(
                    voiceSendControlParams.x, voiceSendControlParams.y,
                    voiceSendControlParams.x + voiceSendControlParams.width,
                    voiceSendControlParams.y + voiceSendControlParams.height), true);
        }
    }

    private void removeVoiceDraftControls() {
        if (compactOverlayRoot != null) {
            if (voiceCancelControl != null) compactOverlayRoot.removeSlot(voiceCancelControl);
            if (voiceSendControl != null) compactOverlayRoot.removeSlot(voiceSendControl);
            compactOverlayRoot.commitFrame();
        }
        voiceCancelControl = null;
        voiceSendControl = null;
        voiceCancelControlParams = null;
        voiceSendControlParams = null;
    }

    private void discardVoiceDraft() {
        voiceInvocationLatched = false;
        forcedReviewableVoiceDraft = false;
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
        suppressFirstTapTurnEmptyCue = false;
        setContinuousVoiceLoop(false);
        cancelContinuousVoiceRestart();
        invalidatePendingBranchSwitch();
        if (streamingVoiceActive()) {
            cancelStreamingVoice();
        } else {
            voiceController.stopQuietly();
            removeTranscriptOverlay();
        }
        setVoiceRuntimeState(VoiceRuntimeState.READY);
        updateMicState();
    }

    private void sendVoiceDraft() {
        if (!voiceInvocationLatched && !reviewableVoiceDraftActive()) {
            return;
        }
        voiceInvocationLatched = false;
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
        forcedReviewableVoiceDraft = false;
        suppressFirstTapTurnEmptyCue = false;
        setContinuousVoiceLoop(false);
        cancelContinuousVoiceRestart();
        if (streamingBranchSwitchPending && streamingVoiceController == null) {
            streamingCommitPendingOpen = true;
            setVoiceRuntimeState(VoiceRuntimeState.SENDING);
            updateMicState();
            return;
        }
        if (streamingVoiceActive() && streamingVoiceController != null) {
            commitStreamingVoiceTurnNow();
            return;
        }
        if (voiceController.isCommandListening()) {
            voiceController.commitCurrentSpeech();
            setVoiceRuntimeState(VoiceRuntimeState.THINKING);
            updateMicState();
            return;
        }
        discardVoiceDraft();
    }

    private void showCurrentScreenContext() {
        if (!actionBroker.isScreenAccessRunning()) {
            updateVoiceAssistantTranscript("Screen access is off. Enable it in AG settings.");
            return;
        }
        String summary = actionBroker.currentScreenSummary();
        updateVoiceAssistantTranscript(summary.isEmpty() ? "I cannot read visible text from this screen yet." : summary);
    }

    private void updateTranscriptOverlay(String text) {
        updateVoiceUserTranscript(text, false);
    }

    private void updateVoiceUserTranscript(String text, boolean isFinal) {
        String value = visibleVoiceContent(text);
        if (value.isEmpty()) {
            return;
        }
        voiceLog.setUser(value, isFinal);
        voiceUserTranscript = value;
        voiceUserTranscriptFinal = isFinal;
        if (!overlayUnit.isShowing()) {
            showTranscriptOverlay(value);
            return;
        }
        renderVoiceTranscriptRows();
    }

    private void updateVoiceAssistantTranscript(String text) {
        String value = safe(text);
        if (value.isEmpty()) {
            return;
        }
        voiceLog.setAssistant(value);
        voiceAssistantTranscript = value;
        if (!overlayUnit.isShowing()) {
            showTranscriptOverlay("");
        }
        setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
        renderVoiceTranscriptRows();
    }

    // The ribbons render the CURRENT turn only. voiceLog stays the source of
    // truth for what was said, but the overlay shows one line per speaker and
    // never stacks: the stacking card is exactly what buried the transcript line
    // the user asked twice to keep visible.
    private void renderVoiceTranscriptRows() {
        String reply = voiceLog.currentAssistantText();
        if (!voiceLog.isEmpty()) {
            MoaVoiceTranscriptLog.Entry newest = voiceLog.get(voiceLog.size() - 1);
            if (newest.interrupted && !newest.isUser()) {
                reply = reply + " · interrupted";
            }
        }
        boolean live = liveConversation.userListening()
                || liveConversation.userPlaceholder()
                || liveConversation.assistantCaret()
                || !liveConversation.assistantFullText().isEmpty();
        overlayUnit.render(
                live ? liveConversation.userText() : voiceLog.currentUserText(),
                live ? liveConversation.assistantCollapsedText() : reply,
                live ? liveConversation.assistantFullText() : reply,
                live ? liveConversation.userListening() : voiceRuntimeState == VoiceRuntimeState.LISTENING,
                live ? liveConversation.assistantCaret()
                        : voiceRuntimeState == VoiceRuntimeState.THINKING
                                || voiceRuntimeState == VoiceRuntimeState.SPEAKING,
                live && liveConversation.userPlaceholder(),
                live && liveConversation.assistantPlaceholder(),
                live ? liveConversation.userUnstableStart() : -1,
                replyToneColor());
    }

    private int replyToneColor() {
        if (voiceRuntimeState == VoiceRuntimeState.ERROR
                || safe(voiceAssistantTranscript).contains("(not spoken)")) {
            return MoaColors.EMBER;
        }
        return 0;
    }

    private void setVoiceRuntimeState(VoiceRuntimeState state) {
        voiceRuntimeState = state == null ? VoiceRuntimeState.READY : state;
        updateVoiceHeaderState();
        // Single choke point for the orb's response state so the lion visibly
        // reflects thinking / responding / error without touching other call
        // sites. The watchdog + error paths become visible here for free.
        updateVoiceDraftControls();
        if (orbView != null) {
            orbView.setResponseState(orbResponseStateFor(voiceRuntimeState));
        }
    }

    private OrbView.ResponseState orbResponseStateFor(VoiceRuntimeState state) {
        switch (state) {
            case SENDING:
            case THINKING:
                return OrbView.ResponseState.THINKING;
            case SPEAKING:
                return OrbView.ResponseState.RESPONDING;
            case ERROR:
            case RECOVERING:
                return OrbView.ResponseState.ERROR;
            default:
                return OrbView.ResponseState.NONE;
        }
    }

    // The unit carries no header, no status line, no language line and no run
    // meta: that was card chrome, and chrome is what made the overlay occlude.
    // Runtime state now shows through the companion's own animation and the
    // ribbons' caret and tone.
    private void updateVoiceHeaderState() {
        renderVoiceTranscriptRows();
    }

    private String visibleVoiceContent(String text) {
        String value = safe(text);
        return isVoiceTransportText(value) ? "" : value;
    }

    private boolean isVoiceTransportText(String text) {
        String value = safe(text).toLowerCase(Locale.US);
        return value.isEmpty()
                || value.equals("listening")
                || value.equals("listening...")
                || value.equals("recording")
                || value.equals("recording...")
                || value.equals("sending")
                || value.equals("sending...")
                || value.equals("ready")
                || value.equals("ready.")
                || value.equals("response received.")
                || value.equals("response complete.")
                || value.equals("playing response...")
                || value.equals("connecting to voice gateway...")
                || value.equals("routing through moa...");
    }

    private void removeTranscriptOverlay() {
        cancelAutoDismiss();
        // The live turn dies with its surface: a later showTranscriptOverlay
        // must not resurrect a stale placeholder or spoken-progress override.
        liveConversation.clear();
        overlayUnit.hide();
    }

    private void cancelAutoDismiss() {
        if (pendingAutoDismiss != null) {
            mainHandler.removeCallbacks(pendingAutoDismiss);
            pendingAutoDismiss = null;
        }
    }

    private void holdVoiceReplyThenContinueOrDismiss() {
        mainHandler.postDelayed(this::completeVoiceReplyPlayback, VOICE_RESPONSE_HOLD_MS);
    }

    private void completeVoiceReplyPlayback() {
        setVoiceRuntimeState(VoiceRuntimeState.READY);
        updateMicState();
        if (continuousVoiceLoop) {
            scheduleContinuousVoiceRestart(streamingVoiceGeneration);
        }
    }

    // The ONE place the microphone re-arms itself hands-free, so it is the one
    // place the bound has to hold. allowRearm releases the mic and says so when
    // the loop has run out of silence budget or session time.
    private void scheduleContinuousVoiceRestart(int generation) {
        if (!captureLoop.allowRearm(heardSpeechThisTurn(), SystemClock.uptimeMillis())) {
            return;
        }
        suppressFirstTapTurnEmptyCue = false;
        cancelAutoDismiss();
        cancelContinuousVoiceRestart();
        beginWarmMic();
        pendingContinuousVoiceRestart = () -> {
            pendingContinuousVoiceRestart = null;
            if (!continuousVoiceLoop || generation != streamingVoiceGeneration) {
                return;
            }
            startStreamingVoiceTurn(true, true);
        };
        mainHandler.postDelayed(pendingContinuousVoiceRestart, CONTINUOUS_VOICE_RESTART_MS);
    }

    // Arming and disarming the bound is bolted to the flag itself, so every one of
    // the existing exit paths — dismiss, error, barge-in, cancel, discard — keeps
    // working unchanged and cannot leave the bound armed behind them.
    private void setContinuousVoiceLoop(boolean value) {
        continuousVoiceLoop = value;
        if (value) {
            captureLoop.arm(SystemClock.uptimeMillis());
        } else {
            captureLoop.disarm();
        }
    }

    // A turn "heard speech" when it left a real transcript behind. This reuses the
    // existing judgement: visibleVoiceContent already discards the synthetic
    // transport strings, and a gateway no_speech turn never sets a transcript.
    private boolean heardSpeechThisTurn() {
        return !visibleVoiceContent(currentStreamingTranscript).isEmpty();
    }

    private MoaContinuousCaptureLoop.Capture continuousCaptureSink() {
        return new MoaContinuousCaptureLoop.Capture() {
            @Override
            public void cancelPendingRestart() {
                cancelContinuousVoiceRestart();
            }

            @Override
            public void releaseWarmMic() {
                discardWarmMic();
            }

            @Override
            public void stopActiveCapture() {
                if (streamingVoiceActive()) {
                    cancelStreamingVoice();
                    return;
                }
                voiceController.stopQuietly();
            }

            @Override
            public void announceExit(String notice) {
                updateVoiceAssistantTranscript(notice);
            }

            @Override
            public void markReadyToRearm() {
                // A bound, not a lockout: the normal gesture re-arms immediately.
                manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
                forcedReviewableVoiceDraft = false;
                suppressFirstTapTurnEmptyCue = false;
                setVoiceRuntimeState(VoiceRuntimeState.READY);
                updateMicState();
            }
        };
    }

    private void cancelContinuousVoiceRestart() {
        if (pendingContinuousVoiceRestart != null) {
            mainHandler.removeCallbacks(pendingContinuousVoiceRestart);
            pendingContinuousVoiceRestart = null;
        }
        pendingContinuousVoiceRestartAfterAudio = false;
    }

    private String orbGestureHint() {
        if (MoaPrefs.voiceFirstGestures(this)) {
            return recordModeEnabled
                    ? "Notes mode: tap to start, tap again to store. Hold-release also stores."
                    : "Tap toggles talk. Double-tap toggles a new thread. Triple-tap opens chat. Hold-release sends.";
        }
        return recordModeEnabled
                ? "Record mode: double-click and hold to record a note."
                : "Tap for chat. Double-click and hold to talk.";
    }

    private void sendUserMessage(String text, boolean fromVoice) {
        addMessage(false, text);
        if (fromVoice) {
            showTranscriptOverlay("");
            updateVoiceUserTranscript(text, true);
            setVoiceRuntimeState(VoiceRuntimeState.THINKING);
        }
        boolean forcedAgent = nextVoiceRunsAgent;
        nextVoiceRunsAgent = false;
        String manualVoiceFollowUpRunId = fromVoice ? nextManualVoiceFollowUpRunId : "";
        nextManualVoiceFollowUpRunId = "";
        MoaActionBroker.LocalActionResult localAction = actionBroker.tryHandleLocalCommand(text);
        if (localAction.handled) {
            deliverReply(localAction.reply, fromVoice);
            return;
        }
        if (!manualVoiceFollowUpRunId.isEmpty()) {
            requestAgentRunFollowUp(manualVoiceFollowUpRunId, text, true);
            return;
        }
        if (!gatewayUrl.isEmpty() && fromVoice) {
            requestVoiceTurn(text, fromVoice, forcedAgent);
            return;
        }
        String agentPrompt = agentPromptFrom(text);
        if (agentPrompt.isEmpty() && (forcedAgent || shouldRunAgentFromVoice(text, fromVoice))) {
            agentPrompt = spokenAgentPrompt(text);
        }
        if (!agentPrompt.isEmpty()) {
            requestAgentRun(agentPrompt, fromVoice);
            return;
        }
        if (!gatewayUrl.isEmpty() && shouldRouteOperationalTurnThroughMoa(text)) {
            requestVoiceTurn(text, fromVoice, shouldForceAgentForMoaRoutedTurn(text));
            return;
        }
        if (gatewayUrl.isEmpty()) {
            deliverReply("The gateway isn't connected yet. Open the AG app to set it up.", fromVoice);
            return;
        }
        requestGatewayReply(text, fromVoice);
    }

    private void deliverReply(String reply, boolean fromVoice) {
        deliverReply(reply, fromVoice, fromVoice);
    }

    private void deliverReply(String reply, boolean fromVoice, boolean speakReply) {
        if (reply == null || reply.trim().isEmpty()) {
            return;
        }
        addMessage(true, reply);
        boolean speaking = false;
        if (fromVoice) {
            updateVoiceAssistantTranscript(reply);
            setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
        }
        if (speakReply && fromVoice && MoaPrefs.spokenRepliesEnabled(this) && voiceController.isIdle()) {
            speaking = voiceController.speak(reply);
        }
        if (fromVoice && !speaking) {
            holdVoiceReplyThenContinueOrDismiss();
        }
    }

    private void requestVoiceTurn(String userText, boolean fromVoice, boolean forcedAgent) {
        JSONObject requestBody;
        try {
            requestBody = voiceTurnRequestBody(userText, fromVoice, forcedAgent);
        } catch (JSONException error) {
            if (forcedAgent) requestAgentRun(spokenAgentPrompt(userText), fromVoice);
            else requestGatewayReply(userText, fromVoice);
            return;
        }
        final boolean exactBoundary = MoaContextControlState.requiresExactBoundary(requestBody);
        new Thread(() -> {
            try {
                JSONObject response = gatewayClient().voiceTurn(requestBody);
                mainHandler.post(() -> deliverVoiceTurnReply(response, userText, fromVoice, forcedAgent));
            } catch (Exception error) {
                mainHandler.post(() -> {
                    if (exactBoundary) {
                        deliverReply("That new thread could not be started. Try again.", fromVoice, false);
                        return;
                    }
                    if (forcedAgent) requestAgentRun(spokenAgentPrompt(userText), fromVoice);
                    else requestGatewayReply(userText, fromVoice);
                });
            }
        }, "moa-voice-turn").start();
    }

    private JSONObject voiceTurnRequestBody(String userText, boolean fromVoice, boolean forcedAgent) throws JSONException {
        JSONObject body = gatewayRequestBody();
        body.put("session_id", conversationId);
        body.put("branch_id", activeBranchId);
        body.put("turn_id", "turn_" + UUID.randomUUID().toString());
        body.put("transcript", userText);
        body.put("text", userText);
        if (forcedAgent) {
            body.put("forced_action", "agent_run");
        }
        JSONObject client = new JSONObject();
        client.put("platform", "android");
        client.put("source", "android-overlay");
        client.put("device_id", androidDeviceId());
        client.put("input", fromVoice ? "voice" : "text");
        client.put("intent_hint", forcedAgent ? "agent_run" : "unknown");
        body.put("client", client);
        return body;
    }

    private void deliverVoiceTurnReply(JSONObject response, String userText, boolean fromVoice, boolean forcedAgent) {
        updateConversationId(response.optString("conversation_id", ""));
        updateActiveBranchId(MoaGatewayClient.branchIdFromTurn(response));
        String display = response.optString("display", "").trim();
        String speakText = response.optString("speak", "").trim();
        String text = display.isEmpty() ? response.optString("text", speakText).trim() : display;
        if (text.isEmpty()) {
            // The gateway answered with no display, speak, or text. On the voice
            // path the overlay was left in THINKING forever; reset it to READY
            // with a visible notice instead of a silent hang.
            if (fromVoice) {
                showStreamingVoiceFailure(
                        "Voice returned no reply.",
                        streamingVoiceGeneration);
            }
            return;
        }
        // An incognito voice turn is answered but never stored; mark the visible
        // reply so the user knows nothing was saved. The spoken `speak` string is
        // left untouched so the marker is never read aloud.
        if (MoaGatewayClient.turnNotPersisted(response)) {
            text = MoaContextControlState.appendNotSaved(text);
        }
        boolean shouldSpeak = fromVoice && !speakText.isEmpty();
        boolean speaking = false;
        addMessage(true, text);
        if (fromVoice) {
            updateVoiceAssistantTranscript(text);
            setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
        }
        trackAgentRunsFromResponse(response);
        if ("profile_control".equals(response.optString("classification", "")) || response.optJSONObject("profile") != null) {
            refreshVoiceProfile();
        }
        boolean samplingVoices = maybeStartVoiceSampler(response, fromVoice);
        if (samplingVoices) {
            shouldSpeak = false;
            speaking = true;
        }
        if (shouldSpeak && MoaPrefs.spokenRepliesEnabled(this) && voiceController.isIdle()) {
            speaking = voiceController.speak(speakText);
        }
        if (fromVoice && !speaking) {
            holdVoiceReplyThenContinueOrDismiss();
        }
    }

    private boolean maybeStartVoiceSampler(JSONObject response, boolean fromVoice) {
        if (!fromVoice || !MoaPrefs.spokenRepliesEnabled(this)) {
            return false;
        }
        JSONObject sampler = voiceSamplerActionFrom(response);
        if (sampler == null) {
            return false;
        }
        JSONArray voices = sampler.optJSONArray("voices");
        if (voices == null || voices.length() == 0) {
            return false;
        }
        if (voiceSamplePlayer != null) {
            voiceSamplePlayer.destroy();
            voiceSamplePlayer = null;
        }
        loadSettings();
        final int total = voices.length();
        voiceSamplePlayer = new MoaVoiceSamplePlayer(gatewayUrl, gatewayToken, conversationId, voices, new MoaVoiceSamplePlayer.Callback() {
            @Override
            public void onSampleStarted(String voiceId, int index, int total) {
                mainHandler.post(() -> {
                    updateVoiceAssistantTranscript("Sampling " + voiceId + " (" + index + "/" + total + ")");
                    setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
                    updateMicState();
                });
            }
            @Override
            public void onSampleText(String voiceId, String text) {
                mainHandler.post(() -> {
                    if (!safe(text).isEmpty()) {
                        updateVoiceAssistantTranscript(text);
                    }
                });
            }
            @Override
            public void onSampleDone(String voiceId, int index, int total) {
            }
            @Override
            public void onComplete() {
                mainHandler.post(() -> {
                    voiceSamplePlayer = null;
                    updateVoiceAssistantTranscript("Voice sampler finished.");
                    setVoiceRuntimeState(VoiceRuntimeState.READY);
                    holdVoiceReplyThenContinueOrDismiss();
                });
            }
            @Override
            public void onError(String message, Throwable error) {
                mainHandler.post(() -> {
                    voiceSamplePlayer = null;
                    Log.w(TAG, "voice sampler failed: " + safe(message));
                    updateVoiceAssistantTranscript("The voice sampler failed. Try again.");
                    setVoiceRuntimeState(VoiceRuntimeState.ERROR);
                    holdVoiceReplyThenContinueOrDismiss();
                });
            }
        });
        updateVoiceAssistantTranscript("Starting voice sampler (" + total + " voices).");
        setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
        voiceSamplePlayer.start();
        return true;
    }

    private JSONObject voiceSamplerActionFrom(JSONObject response) {
        JSONArray actions = response.optJSONArray("actions");
        if (actions == null) {
            return null;
        }
        for (int i = 0; i < actions.length(); i++) {
            JSONObject action = actions.optJSONObject(i);
            if (action != null && "voice_sampler".equals(action.optString("type", ""))) {
                return action;
            }
        }
        return null;
    }

    private void requestGatewayReply(String userText, boolean fromVoice) {
        JSONObject requestBody;
        try {
            requestBody = gatewayRequestBody();
        } catch (JSONException error) {
            deliverReply("I couldn't send that. Try again.", fromVoice);
            return;
        }
        new Thread(() -> {
            try {
                MoaGatewayClient.GatewayTextResponse reply = gatewayClient().chat(requestBody);
                mainHandler.post(() -> {
                    updateConversationId(reply.conversationId);
                    updateActiveBranchId(reply.branchId);
                    deliverReply(reply.notSaved ? MoaContextControlState.appendNotSaved(reply.text) : reply.text, fromVoice);
                });
            } catch (Exception error) {
                Log.w(TAG, "gateway chat failed: " + cleanError(error));
                mainHandler.post(() -> deliverReply(
                        "I can't reach the gateway right now. Check the connection and try again.", fromVoice));
            }
        }, "moa-gateway").start();
    }

    private void requestAgentRun(String prompt, boolean fromVoice) {
        if (gatewayUrl.isEmpty()) {
            deliverReply("Agent actions need the AG gateway. Set the home-machine URL first.", fromVoice);
            return;
        }
        JSONObject requestBody;
        try {
            JSONObject body = new JSONObject();
            body.put("conversation_id", conversationId);
            body.put("branch_id", activeBranchId);
            body.put("source", "android-overlay");
            body.put("device_id", androidDeviceId());
            body.put("wait", false);
            body.put("prompt", truncatePrompt(actionBroker.promptWithScreenContext(prompt)));
            actionBroker.putScreenContext(body);
            requestBody = body;
        } catch (JSONException error) {
            deliverReply("I could not prepare that home-machine agent run.", fromVoice);
            return;
        }
        new Thread(() -> {
            try {
                JSONObject response = gatewayClient().agentRun(requestBody);
                mainHandler.post(() -> {
                    trackAgentRunsFromResponse(response);
                    deliverReply(MoaGatewayClient.agentRunReply(response), fromVoice, false);
                });
            } catch (Exception error) {
                Log.w(TAG, "agent run failed: " + cleanError(error));
                mainHandler.post(() -> deliverReply(
                        "The agent run didn't start. Check the gateway connection and try again.", fromVoice));
            }
        }, "moa-agent-run").start();
    }

    private void requestAgentRunFollowUp(String parentRunId, String text, boolean fromVoice) {
        if (parentRunId.isEmpty()) {
            requestVoiceTurn(text, fromVoice, true);
            return;
        }
        JSONObject requestBody;
        try {
            JSONObject body = new JSONObject();
            body.put("conversation_id", conversationId);
            body.put("branch_id", activeBranchId);
            body.put("intent_id", agentRuns.intentIdForRun(parentRunId));
            body.put("source", "android-overlay");
            body.put("device_id", androidDeviceId());
            body.put("prompt", text);
            actionBroker.putScreenContext(body);
            requestBody = body;
        } catch (JSONException error) {
            deliverReply("I could not prepare the agent follow-up.", fromVoice, false);
            return;
        }
        new Thread(() -> {
            try {
                JSONObject response = gatewayClient().agentRunFollowUp(parentRunId, requestBody);
                mainHandler.post(() -> {
                    trackAgentRunsFromResponse(response);
                    deliverReply(MoaGatewayClient.agentRunReply(response), fromVoice, false);
                });
            } catch (Exception error) {
                Log.w(TAG, "agent follow-up failed: " + cleanError(error));
                mainHandler.post(() -> deliverReply(
                        "That didn't reach the agent. Try again.", fromVoice, false));
            }
        }, "moa-agent-follow-up").start();
    }

    private JSONObject gatewayRequestBody() throws JSONException {
        JSONObject body = MoaOverlayGatewayRequests.turnBody(
                getContentResolver(), conversationId, activeBranchId,
                messages, MAX_GATEWAY_MESSAGES, actionBroker);
        applyContextControls(body);
        return body;
    }

    private void applyContextControls(JSONObject body) throws JSONException {
        if (contextControls.applyTo(body)) {
            refreshContextControls();
        }
    }

    private String androidDeviceId() {
        return MoaOverlayGatewayRequests.deviceId(getContentResolver());
    }

    private MoaGatewayClient gatewayClient() {
        return new MoaGatewayClient(gatewayUrl, gatewayToken);
    }

    private void startDeviceClientLoop() {
        if (deviceClientLoopRunning) {
            return;
        }
        deviceClientLoopRunning = true;
        mainHandler.post(this::pollDeviceClientThenSchedule);
    }

    private void pollDeviceClientThenSchedule() {
        if (!deviceClientLoopRunning) {
            return;
        }
        pollDeviceClientOnce();
        mainHandler.postDelayed(this::pollDeviceClientThenSchedule, DEVICE_CLIENT_POLL_MS);
    }

    private void pollDeviceClientOnce() {
        if (deviceClientPollInFlight || !toolRequestGate.active().isEmpty()) {
            return;
        }
        loadSettings();
        if (gatewayUrl.isEmpty()) {
            return;
        }
        JSONObject heartbeat;
        JSONObject claim;
        try {
            heartbeat = deviceClientHeartbeatBody();
            claim = deviceClientClaimBody();
        } catch (JSONException error) {
            return;
        }
        deviceClientPollInFlight = true;
        final String url = gatewayUrl;
        final String token = gatewayToken;
        new Thread(() -> {
            try {
                MoaGatewayClient client = new MoaGatewayClient(url, token);
                MoaToolReceiptOutbox.Snapshot receipts = toolReceiptOutbox.snapshot();
                if (!receipts.healthy || !receipts.uncertainReservations.isEmpty()) return;
                for (MoaToolReceiptOutbox.PendingReceipt pending : receipts.pending) {
                    JSONObject response = client.toolRequestReceipt(pending.requestId, pending.body());
                    MoaToolReceiptOutbox.Acknowledgement acknowledgement =
                            MoaToolReceiptOutbox.gatewayAcknowledgement(pending, response);
                    if (toolReceiptOutbox.acknowledge(pending, acknowledgement)
                            != MoaToolReceiptOutbox.AckResult.REMOVED) return;
                }
                client.deviceHeartbeat(heartbeat);
                JSONObject claimed = client.claimToolRequest(claim);
                JSONObject request = claimed.optJSONObject("request");
                if (request != null && !request.optString("id", "").trim().isEmpty()) {
                    mainHandler.post(() -> executeClaimedToolRequest(request));
                }
            } catch (Exception ignored) {
                // The device heartbeat is best-effort background infrastructure.
            } finally {
                deviceClientPollInFlight = false;
            }
        }, "moa-device-client").start();
    }

    private JSONObject deviceClientHeartbeatBody() throws JSONException {
        JSONObject body = new JSONObject();
        body.put("device_id", androidDeviceId());
        body.put("surface_type", "android");
        body.put("session_id", conversationId);
        body.put("status", "online");
        body.put("local_tool_manifest", androidLocalToolManifest());
        JSONObject metadata = new JSONObject();
        metadata.put("source", "android-overlay");
        metadata.put("screen_access_enabled", actionBroker.isScreenAccessEnabled());
        metadata.put("screen_access_running", actionBroker.isScreenAccessRunning());
        metadata.put("overlay_running", true);
        metadata.put("context_descriptor", actionBroker.activeAppDescriptor());
        metadata.put("execution_adapters", actionBroker.executionAdapters());
        metadata.put("media_session", actionBroker.mediaSessionDescriptor());
        body.put("metadata", metadata);
        return body;
    }
    private JSONObject deviceClientClaimBody() throws JSONException {
        JSONObject body = new JSONObject();
        body.put("device_id", androidDeviceId());
        body.put("surface_type", "android");
        body.put("local_tool_manifest", androidLocalToolManifest());
        return body;
    }

    private JSONArray androidLocalToolManifest() throws JSONException {
        return actionBroker.localToolManifest().put(new JSONObject()
                .put("tool", "audio.speak").put("risk", "local_output")
                .put("approval", "implicit_user_command"));
    }
    private void executeClaimedToolRequest(JSONObject request) {
        String requestId = safe(request.optString("id", ""));
        String claimId = safe(request.optString("claim_id", ""));
        if (!running || !toolRequestGate.start(requestId)) return;
        MoaToolReceiptOutbox.Reservation reservation = toolReceiptOutbox.reserve(
                requestId, claimId, androidDeviceId());
        if (!reservation.mayExecute()) {
            toolRequestGate.finish(requestId);
            return;
        }
        activeToolReservation = reservation;
        activeToolName = safe(request.optString("tool", ""));
        String tool = safe(request.optString("tool", ""));
        JSONObject supplied = request.optJSONObject("input");
        final JSONObject input = supplied == null ? new JSONObject() : supplied;
        MoaToolRequestExecution execution;
        if ("audio.speak".equals(tool)) {
            execution = executeAudioSpeakRequest(input);
        } else {
            MoaActionBroker.ToolExecutionResult result = actionBroker.executeToolRequest(
                    requestId, tool, input, completed -> mainHandler.post(() -> handleAsyncToolResult(requestId, tool, input, completed)));
            if (result.requiresConfirmation) {
                showToolConfirmation(requestId, tool, input, result.reply);
                return;
            }
            if (result.pending) return;
            execution = new MoaToolRequestExecution(result.success, result.reply, result.receipt);
        }
        finishClaimedToolRequest(requestId, execution);
    }
    private void handleAsyncToolResult(String requestId, String tool, JSONObject input,
            MoaActionBroker.ToolExecutionResult result) {
        if (!running) return;
        if (result.requiresConfirmation) {
            showToolConfirmation(requestId, tool, input, result.reply);
            return;
        }
        if (!result.pending) finishClaimedToolRequest(requestId,
                new MoaToolRequestExecution(result.success, result.reply, result.receipt));
    }
    private void finishClaimedToolRequest(String requestId, MoaToolRequestExecution execution) {
        MoaToolReceiptOutbox.Reservation reservation = activeToolReservation;
        if (reservation == null || !requestId.equals(reservation.requestId)) return;
        String tool = activeToolName;
        MoaToolReceiptOutbox.Completion completion = toolReceiptOutbox.complete(
                reservation, tool, execution.success, execution.summary, execution.receipt);
        if (!completion.readyToSend()) {
            addMessage(true, "Local action finished, but its durable receipt is blocked; device actions are paused.");
            return;
        }
        activeToolReservation = null;
        activeToolName = "";
        if (!toolRequestGate.finish(requestId)) return;
        String message = execution.success
                ? "Cross-device request completed: " + execution.summary
                : "Cross-device request failed: " + execution.summary;
        addMessage(true, message);
        if (!requestId.isEmpty()) {
            postToolRequestReceipt(completion.pending);
        }
    }
    private void showToolConfirmation(String requestId, String tool, JSONObject input, String message) {
        if (toolConfirmationDialog != null) {
            finishToolConfirmation(requestId, tool, input, false);
            return;
        }
        final boolean[] decision = {false, false};
        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Confirm media change").setMessage(message)
                .setOnCancelListener(ignored -> completeToolDialogDecision(
                        decision, requestId, tool, input, false))
                .setNegativeButton("Cancel", (ignored, which) -> completeToolDialogDecision(
                        decision, requestId, tool, input, false))
                .setPositiveButton("Allow", null).create();
        toolConfirmationDialog = dialog;
        dialog.setOnDismissListener(ignored -> {
            if (toolConfirmationDialog == dialog) toolConfirmationDialog = null;
            if (!running || !decision[0]) {
                finishToolConfirmation(requestId, tool, input, false);
            } else if (decision[1]) {
                finishApprovedWhenTargetVisible(requestId, tool, input, 5);
            }
        });
        if (dialog.getWindow() != null) dialog.getWindow().setType(MoaOverlayWindowType.resolve());
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(ignored -> {
            if (!decision[0]) { decision[0] = true; decision[1] = true; dialog.dismiss(); }
        });
    }
    private void finishApprovedWhenTargetVisible(
            String requestId, String tool, JSONObject input, int attempts) {
        String target = MoaAccessibilityService.freshActivePackage();
        if (running && !target.isEmpty() && !getPackageName().equals(target)) {
            finishToolConfirmation(requestId, tool, input, true);
        } else if (running && attempts > 0) {
            mainHandler.postDelayed(() -> finishApprovedWhenTargetVisible(
                    requestId, tool, input, attempts - 1), 80L);
        } else {
            finishToolConfirmation(requestId, tool, input, false);
        }
    }
    private void completeToolDialogDecision(boolean[] decision, String requestId,
            String tool, JSONObject input, boolean approved) {
        if (decision[0]) return;
        decision[0] = true;
        decision[1] = approved;
        if (!approved) finishToolConfirmation(requestId, tool, input, false);
    }
    private void finishToolConfirmation(String requestId, String tool, JSONObject input, boolean approved) {
        MoaActionBroker.ToolExecutionResult result = actionBroker.resolveToolConfirmation(
                requestId, tool, input, approved,
                completed -> mainHandler.post(() -> finishClaimedToolRequest(requestId,
                        new MoaToolRequestExecution(completed.success, completed.reply, completed.receipt))));
        if (result.pending) return;
        finishClaimedToolRequest(requestId,
                new MoaToolRequestExecution(result.success, result.reply, result.receipt));
    }

    private MoaToolRequestExecution executeAudioSpeakRequest(JSONObject input) {
        String text = safe(input.optString("text", input.optString("message", input.optString("utterance", ""))));
        if (text.isEmpty()) {
            JSONObject receipt = MoaActionReceiptStore.record(this, "audio.speak", "local_output", "implicit_user_command", "", false, "Speech text is required.");
            return new MoaToolRequestExecution(false, "Speech text is required.", receipt);
        }
        boolean spoken = voiceController != null && voiceController.speak(text);
        String summary = spoken
                ? "Spoke requested text."
                : "On-device speech is disabled by policy; replies speak through hosted audio only.";
        JSONObject receipt = MoaActionReceiptStore.record(
                this, "audio.speak", "local_output", "implicit_user_command",
                "device_speaker", spoken, summary);
        return new MoaToolRequestExecution(spoken, summary, receipt);
    }

    private void postToolRequestReceipt(MoaToolReceiptOutbox.PendingReceipt pending) {
        final String url = gatewayUrl;
        final String token = gatewayToken;
        new Thread(() -> {
            try {
                JSONObject response = new MoaGatewayClient(url, token)
                        .toolRequestReceipt(pending.requestId, pending.body());
                toolReceiptOutbox.acknowledge(pending,
                        MoaToolReceiptOutbox.gatewayAcknowledgement(pending, response));
            } catch (Exception ignored) {
                // The exact terminal envelope remains durable for the next poll.
            }
        }, "moa-tool-receipt").start();
    }

    private void trackAgentRunsFromResponse(JSONObject response) {
        if (response == null) {
            return;
        }
        agentRuns.trackResponse(response);
        updateAgentRunStatus();
        ensureAgentRunPolling();
    }

    private void ensureAgentRunPolling() {
        if (agentRunPolling || !agentRuns.hasRuns()) {
            return;
        }
        agentRunPolling = true;
        mainHandler.postDelayed(this::pollAgentRunsOnce, 1200);
    }

    private void pollAgentRunsOnce() {
        if (!agentRuns.hasRuns()) {
            agentRunPolling = false;
            updateAgentRunStatus();
            return;
        }
        List<String> ids = agentRuns.ids();
        new Thread(() -> {
            List<MoaAgentRunTracker.State> updates = new ArrayList<>();
            for (String id : ids) {
                try {
                    JSONObject response = gatewayClient().agentRunDetail(id);
                    JSONObject run = response.optJSONObject("run");
                    if (run != null) {
                        updates.add(MoaAgentRunTracker.pollUpdate(id, run));
                    }
                } catch (Exception error) {
                    updates.add(MoaAgentRunTracker.failedPollUpdate(id, cleanError(error)));
                }
            }
            mainHandler.post(() -> applyAgentRunUpdates(updates));
        }, "moa-agent-run-poll").start();
    }

    private void applyAgentRunUpdates(List<MoaAgentRunTracker.State> updates) {
        for (String completion : agentRuns.applyUpdates(updates)) {
            addMessage(true, completion);
        }
        updateAgentRunStatus();
        if (!agentRuns.hasRuns()) {
            agentRunPolling = false;
        } else {
            mainHandler.postDelayed(this::pollAgentRunsOnce, 2500);
        }
    }

    private void updateAgentRunStatus() {
        composerPanel.setHeaderStatus(overlayHeaderStatusText());
        updateVoiceHeaderState();
    }

    private String overlayHeaderStatusText() {
        String runStatus = agentRunStatusText();
        return "Ready".equals(runStatus) ? MoaPrefs.companionCompactStatus(this) : runStatus;
    }

    private String agentRunStatusText() {
        return agentRuns.statusText();
    }

    private void updateConversationId(String returnedConversationId) {
        String value = safe(returnedConversationId);
        if (value.isEmpty()) {
            return;
        }
        conversationId = value;
        MoaPrefs.setConversationId(this, value);
        activeBranchId = MoaPrefs.conversationBranchId(this, value);
    }

    private void updateActiveBranchId(String returnedBranchId) {
        String value = safe(returnedBranchId);
        if (value.isEmpty() || value.startsWith("inc-")) return;
        activeBranchId = value;
        MoaPrefs.setConversationBranchId(this, conversationId, value);
    }
    private String scopedFollowUpRunId() {
        if (contextControls.isNewThreadArmed() || contextControls.isIncognitoEnabled()) return "";
        MoaAgentRunTracker.FollowUpResolution resolution =
                agentRuns.resolveFollowUp(conversationId, activeBranchId);
        return resolution.kind == MoaAgentRunTracker.FollowUpResolution.Kind.BOUND ? resolution.runId : "";
    }

    private String agentPromptFrom(String text) {
        return MoaOperationalTurnRouter.agentPromptFrom(text);
    }

    private boolean shouldRunAgentFromVoice(String text, boolean fromVoice) {
        return MoaOperationalTurnRouter.shouldRunAgentFromVoice(text, fromVoice);
    }

    private String spokenAgentPrompt(String text) {
        return "The user spoke this from the AG Android overlay and expects forward progress, not a chat-only answer.\n\n"
                + "User request:\n"
                + safe(text)
                + "\n\nWork in the configured repository. Inspect the current state, make the smallest useful code changes, run the relevant verification, and report the result plainly. Ask for clarification only if the task is genuinely blocked.";
    }

    private String truncatePrompt(String prompt) {
        String value = safe(prompt);
        if (value.length() <= MAX_AGENT_PROMPT_CHARS) {
            return value;
        }
        return value.substring(0, MAX_AGENT_PROMPT_CHARS);
    }

    private void handleOrbSingleTap() {
        showPanel();
    }

    // True only while the user owns an open manual capture. Assistant playback
    // and reasoning are not capture: tapping then interrupts and starts a new turn.
    private boolean isManualTapCaptureActive() {
        return audioNoteActive || voiceInvocationLatched || reviewableVoiceDraftActive();
    }

    private MoaVoiceFirstTapResolver.CaptureOrigin manualTapCaptureOrigin() {
        return isManualTapCaptureActive()
                ? manualTapCaptureOrigin
                : MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
    }

    // VOICE-FIRST single quick tap (draft off) = start a reviewable draft with
    // barge-in. Starting stops any assistant audio first, which is the interrupt.
    // A tap never cuts a live user mic: while a PTT hold or a record capture owns
    // the mic this is a no-op, so nothing spoken is dropped.
    private void handleOrbStartTalkLoop() {
        if (pushToTalkVoiceTurn || audioNoteActive) {
            return;
        }
        boolean freshThread = nextVoiceCaptureFreshThread;
        manualTapCaptureOrigin = freshThread
                ? MoaVoiceFirstTapResolver.CaptureOrigin.FRESH_THREAD
                : MoaVoiceFirstTapResolver.CaptureOrigin.CURRENT_THREAD;
        if (recordModeEnabled) {
            startAudioNoteCapture();
            return;
        }
        stopAssistantAudioForBargeIn();
        // Suppress the "didn't catch that" cue for this first turn only: a tap that
        // starts the loop and captures no speech was a barge-in or a stray tap, not
        // a failed utterance. Set after the barge-in teardown clears it.
        suppressFirstTapTurnEmptyCue = true;
        startReviewableVoiceDraft();
        nextVoiceCaptureFreshThread = false;
    }

    private void handleOrbStopAndSend() {
        if (audioNoteActive) {
            finishAudioNoteCapture(false);
            return;
        }
        sendVoiceDraft();
    }

    private void handleVoiceInvocation() {
        MoaVoiceInvocationPolicy.Action action = MoaVoiceInvocationPolicy.decide(
                voiceInvocationLatched || reviewableVoiceDraftActive(),
                pushToTalkVoiceTurn || audioNoteActive);
        if (action == MoaVoiceInvocationPolicy.Action.COMMIT_LATCHED_CAPTURE) {
            sendVoiceDraft();
            return;
        }
        if (action == MoaVoiceInvocationPolicy.Action.START_LATCHED_CAPTURE) {
            voiceInvocationLatched = true;
            handleOrbStartTalkLoop();
        }
    }

    private void handleOrbStartFreshTalkLoop() {
        if (pushToTalkVoiceTurn || audioNoteActive) {
            return;
        }
        if (recordModeEnabled) {
            startAudioNoteCapture();
            manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.FRESH_THREAD;
            return;
        }
        contextControls.armNewThread();
        refreshContextControls();
        nextVoiceCaptureFreshThread = true;
        handleOrbStartTalkLoop();
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.FRESH_THREAD;
    }

    private void handleOrbCancelTalkLoop() {
        suppressFirstTapTurnEmptyCue = false;
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
        if (audioNoteActive) {
            cancelAudioNoteCapture();
        }
        discardVoiceDraft();
        voiceLog.clear();
        removeTranscriptOverlay();
        updateMicState();
    }

    // Stop any assistant audio so a tap-to-talk starts on a quiet mic. Cancels an
    // in-flight streaming turn's playback, a local TTS reply, and the voice
    // sampler. A fresh session opens immediately after.
    private void stopAssistantAudioForBargeIn() {
        cancelContinuousVoiceRestart();
        liveConversation.clear();
        voiceLog.markSteeringBoundary();
        renderVoiceTranscriptRows();
        if (streamingVoiceActive()) {
            pendingReplacementTurnId = "turn_" + UUID.randomUUID().toString();
            String boundaryId = "steer_" + UUID.randomUUID().toString();
            MoaStreamingVoiceSessionController superseded = streamingVoiceController;
            superseded.cancelForReplacement(
                    pendingReplacementTurnId,
                    boundaryId,
                    nextVoiceCaptureFreshThread ? "fresh_thread" : "steering");
            streamingVoiceController = null;
            mainHandler.postDelayed(superseded::destroy, 500);
            streamingVoiceGeneration++;
        }
        cancelVoiceSampler();
        voiceController.stopQuietly();
    }


    // The escape hatch: a large move after a press-to-talk hold confirmed cancels
    // the capture that hold started (streaming turn or audio note) WITHOUT
    // committing it, so the gesture becomes a plain drag. Nothing is sent.
    private void handleOrbPushToTalkCancel() {
        pushToTalkFinish.intentionalCancel();
        if (audioNoteActive) {
            cancelAudioNoteCapture();
        }
        if (pushToTalkVoiceTurn || streamingVoiceController != null) {
            cancelStreamingVoice();
        }
        pushToTalkVoiceTurn = false;
        discardWarmMic();
        if (orbView != null) {
            orbView.setHeld(false);
        }
        updateMicState();
    }

    private void startPushToTalkVoiceTurn() {
        voiceInvocationLatched = false;
        if (streamingVoiceActive() || voiceController.isActive() || voiceSamplePlayer != null || continuousVoiceLoop || pendingContinuousVoiceRestart != null) {
            dismissOverlayUi(false);
        }
        loadSettings();
        pushToTalkVoiceTurn = true;
        pushToTalkFinish.start();
        if (streamingVoiceAvailable()) {
            setContinuousVoiceLoop(false);
            cancelContinuousVoiceRestart();
            cancelVoiceSampler();
            if (orbView != null) {
                orbView.setHeld(true);
            }
            nextStreamingVoiceFollowUpRunId = scopedFollowUpRunId();
            nextManualVoiceFollowUpRunId = "";
            startStreamingVoiceTurn(false, false);
            return;
        }
        startLocalVoiceTurn(true, false);
    }

    private void handleOrbVoicePressRelease() {
        if (audioNoteActive) {
            finishAudioNoteCapture(false);
            return;
        }
        MoaPushToTalkFinish.Action finishAction = pushToTalkFinish.normalFinish(
                streamingBranchSwitchPending,
                streamingVoiceController != null,
                voiceController.isCommandListening());
        pushToTalkVoiceTurn = false;
        if (orbView != null) {
            orbView.setHeld(false);
        }
        // Released while an incognito / new-thread branch switch is still in
        // flight: the session has not opened yet, so remember to commit as soon
        // as it does instead of dropping the release.
        if (finishAction == MoaPushToTalkFinish.Action.DEFER_UNTIL_OPEN) {
            streamingCommitPendingOpen = true;
            setVoiceRuntimeState(VoiceRuntimeState.SENDING);
            updateMicState();
            return;
        }
        if (finishAction == MoaPushToTalkFinish.Action.COMMIT_STREAMING) {
            commitStreamingVoiceTurnNow();
            return;
        }
        if (finishAction == MoaPushToTalkFinish.Action.COMMIT_LOCAL) {
            voiceController.commitCurrentSpeech();
            setVoiceRuntimeState(VoiceRuntimeState.THINKING);
            updateMicState();
            return;
        }
        updateMicState();
    }

    private void commitStreamingVoiceTurnNow() {
        MoaStreamingVoiceSessionController controller = streamingVoiceController;
        if (controller == null) {
            return;
        }
        currentStreamingTurnCommitRequested = true;
        String transcript = visibleVoiceContent(currentStreamingTranscript);
        if (!transcript.isEmpty()) {
            updateVoiceUserTranscript(transcript, true);
        } else {
            showTranscriptOverlay("");
        }
        // Show a distinct "sending" state on release. It becomes THINKING once
        // the gateway acks the commit or the first turn event arrives.
        setVoiceRuntimeState(VoiceRuntimeState.SENDING);
        updateMicState();
        if (routeCommittedStreamingTranscriptIfNeeded(transcript)) {
            return;
        }
        armStreamingTurnWatchdog(streamingVoiceGeneration);
        controller.commitTurn();
    }

    // Arm the inactivity watchdog for a committed turn. Called on commit and
    // re-armed by every later streaming event via markStreamingTurnProgressing.
    private void armStreamingTurnWatchdog(int generation) {
        resetStreamingTurnWatchdog();
    }

    // Cancel and re-arm the inactivity timer. If no streaming event arrives for
    // STREAMING_TURN_WATCHDOG_MS while a committed turn is in flight, the turn is
    // torn down with a visible + spoken timeout notice instead of hanging in
    // silence. Uses the current streaming generation so a stale timer is inert.
    private void resetStreamingTurnWatchdog() {
        cancelStreamingTurnWatchdog();
        final int generation = streamingVoiceGeneration;
        pendingStreamingTurnWatchdog = () -> {
            pendingStreamingTurnWatchdog = null;
            if (!isCurrentStreamingGeneration(generation)) {
                return;
            }
            Log.w(TAG, "streaming turn inactivity watchdog fired; tearing down stalled turn");
            // Stop the stalled controller but KEEP the card, then show the
            // timeout as a persistent message instead of wiping the transcript.
            stopStreamingVoiceKeepingCard();
            String failure = "The voice turn timed out.";
            showStreamingVoiceFailure(failure, streamingVoiceGeneration);
        };
        mainHandler.postDelayed(pendingStreamingTurnWatchdog, STREAMING_TURN_WATCHDOG_MS);
    }

    private void cancelStreamingTurnWatchdog() {
        if (pendingStreamingTurnWatchdog != null) {
            mainHandler.removeCallbacks(pendingStreamingTurnWatchdog);
            pendingStreamingTurnWatchdog = null;
        }
    }

    // A streaming event arrived. Re-arm the inactivity watchdog (only if it was
    // already armed at commit; pre-commit listening does not start it) and move
    // the visible state from "sending" to "thinking".
    private void markStreamingTurnProgressing() {
        if (pendingStreamingTurnWatchdog != null) {
            resetStreamingTurnWatchdog();
        }
        if (voiceRuntimeState == VoiceRuntimeState.SENDING) {
            setVoiceRuntimeState(VoiceRuntimeState.THINKING);
        }
    }

    // Short spoken feedback for overlay notices (timeouts, no-speech, errors,
    // dropped connections). Mirrors the reply-speak gate: quiet mode and a busy
    // TTS engine both suppress it, but the visible notice always shows.
    private boolean speakOverlayNotice(String text) {
        String value = safe(text);
        if (value.isEmpty()) {
            return false;
        }
        if (!MoaPrefs.spokenRepliesEnabled(this) || voiceController == null || !voiceController.isIdle()) {
            return false;
        }
        return voiceController.speak(value);
    }

    private boolean routeCommittedStreamingTranscriptIfNeeded(String transcript) {
        String value = safe(transcript);
        if (value.isEmpty() || currentStreamingTurnRouted) {
            return false;
        }
        if (!nextStreamingVoiceFollowUpRunId.isEmpty()) {
            String followUpRunId = nextStreamingVoiceFollowUpRunId;
            currentStreamingTurnRouted = true;
            currentStreamingTurnCommitRequested = false;
            nextStreamingVoiceFollowUpRunId = "";
            addMessage(false, value);
            updateVoiceUserTranscript(value, true);
            setVoiceRuntimeState(VoiceRuntimeState.THINKING);
            requestAgentRunFollowUp(followUpRunId, value, true);
            MoaStreamingVoiceSessionController controller = streamingVoiceController;
            if (controller != null) {
                controller.cancel();
            }
            updateMicState();
            return true;
        }
        if (shouldRouteStreamingTranscriptThroughMoa(value)) {
            routeStreamingTranscriptThroughMoa(value);
            return true;
        }
        return false;
    }

    // Close every overlay surface except the orb: the chat panel, the voice
    // transcript card, and any live voice turn. Hide the keyboard too.
    private void dismissOverlayUi() {
        dismissOverlayUi(true);
    }

    // clearVoiceLog=false is used when this is an internal pre-reset before
    // starting a brand-new turn (PTT hold, audio note): the prior transcript
    // rows must persist and the new turn appends to them. A genuine user close
    // (Done button, tap-outside, end-loop) clears the stack.
    private void dismissOverlayUi(boolean clearVoiceLog) {
        voiceInvocationLatched = false;
        cancelAudioNoteCapture();
        discardWarmMic();
        pushToTalkFinish.intentionalCancel();
        pushToTalkVoiceTurn = false;
        forcedReviewableVoiceDraft = false;
        setContinuousVoiceLoop(false);
        suppressFirstTapTurnEmptyCue = false;
        nextManualVoiceFollowUpRunId = "";
        invalidatePendingBranchSwitch();
        cancelContinuousVoiceRestart();
        if (streamingVoiceActive()) {
            cancelStreamingVoice();
        }
        cancelVoiceSampler();
        voiceController.stopQuietly();
        if (clearVoiceLog) {
            voiceLog.clear();
        }
        removeTranscriptOverlay();
        hideKeyboard();
        removePanel();
        if (orbView != null) {
            orbView.setHeld(false);
        }
        updateMicState();
    }

    // Used when the full app opens. Keep the foreground service and orb alive,
    // but remove large overlay surfaces so settings and operational status are
    // usable without the overlay stealing focus.
    private void collapseInteractiveSurfaces() {
        voiceInvocationLatched = false;
        cancelAudioNoteCapture();
        discardWarmMic();
        cancelVoiceSampler();
        voiceLog.clear();
        removeTranscriptOverlay();
        hideKeyboard();
        removePanel();
        if (orbView != null) {
            orbView.setHeld(false);
        }
        updateMicState();
    }

    // DOUBLE-CLICK-AND-HOLD the orb = manual voice. Capture starts once the
    // second press is held briefly, and release commits without provider VAD.
    // While record mode is on, the same gesture records a raw audio note
    // instead: no voice session, no SpeechRecognizer, no STT/LLM/TTS.
    private void handleOrbDoublePressStart() {
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
        if (recordModeEnabled) {
            startAudioNoteCapture();
            return;
        }
        startPushToTalkVoiceTurn();
    }

    // RECORD MODE. Capture raw PCM locally while the orb is held, upload the
    // finished bytes to the gateway as an audio note on release. By
    // construction this path never opens a streaming voice session, never
    // starts SpeechRecognizer, and never plays TTS.
    private void toggleRecordMode() {
        recordModeEnabled = !recordModeEnabled;
        if (!recordModeEnabled && audioNoteActive) {
            cancelAudioNoteCapture();
        }
        refreshRecordModePill();
        renderMessages();
    }

    private void startAudioNoteCapture() {
        if (audioNoteActive) {
            return;
        }
        // Never record on top of a live voice surface.
        if (streamingVoiceActive() || voiceController.isActive() || voiceSamplePlayer != null
                || continuousVoiceLoop || pendingContinuousVoiceRestart != null) {
            dismissOverlayUi(false);
        }
        loadSettings();
        if (!streamingVoiceAvailable()) {
            // No capture path will run; drop any mic warmed by the gesture.
            discardWarmMic();
            showAudioNoteResult("Audio notes need the gateway URL and token in settings.", true);
            return;
        }
        audioNoteBuffer = new ByteArrayOutputStream();
        audioNoteActive = true;
        MoaAudioCaptureController.Callback noteCallback = new MoaAudioCaptureController.Callback() {
            @Override
            public void onPcmChunk(byte[] pcm) {
                appendAudioNoteChunk(pcm);
            }
            @Override
            public void onCaptureStarted() {
            }
            @Override
            public void onCaptureStopped() {
            }
            @Override
            public void onCaptureError(String message, Throwable error) {
                mainHandler.post(() -> failAudioNoteCapture(message));
            }
        };
        // Record mode shares the same double-press gesture, so a mic may already
        // be warm. Adopt it (draining its pre-roll into the note so the start of
        // the recording is not lost); otherwise cold-start a fresh controller.
        MoaAudioCaptureController capture = adoptWarmMic();
        if (capture == null) {
            capture = new MoaAudioCaptureController();
        }
        audioNoteCapture = capture;
        if (orbView != null) {
            orbView.setRecordingNote(true);
        }
        audioNoteCapture.start(noteCallback, true);
    }

    // Called on the capture thread for every 40 ms PCM chunk.
    private void appendAudioNoteChunk(byte[] pcm) {
        ByteArrayOutputStream buffer = audioNoteBuffer;
        if (!audioNoteActive || buffer == null || pcm == null || pcm.length == 0) {
            return;
        }
        boolean capReached;
        synchronized (buffer) {
            int room = AUDIO_NOTE_MAX_BYTES - buffer.size();
            if (room > 0) {
                buffer.write(pcm, 0, Math.min(room, pcm.length));
            }
            capReached = buffer.size() >= AUDIO_NOTE_MAX_BYTES;
        }
        if (capReached) {
            mainHandler.post(() -> finishAudioNoteCapture(true));
        }
    }

    private void finishAudioNoteCapture(boolean capReached) {
        if (!audioNoteActive) {
            return;
        }
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
        audioNoteActive = false;
        MoaAudioCaptureController capture = audioNoteCapture;
        audioNoteCapture = null;
        if (capture != null) {
            capture.stop();
        }
        if (orbView != null) {
            orbView.setRecordingNote(false);
        }
        ByteArrayOutputStream buffer = audioNoteBuffer;
        audioNoteBuffer = null;
        byte[] audio;
        if (buffer == null) {
            audio = new byte[0];
        } else {
            synchronized (buffer) {
                audio = buffer.toByteArray();
            }
        }
        if (audio.length == 0) {
            showAudioNoteResult("No audio captured.", true);
            return;
        }
        uploadAudioNote(audio, capReached);
    }

    private void failAudioNoteCapture(String message) {
        if (!audioNoteActive) {
            return;
        }
        cancelAudioNoteCapture();
        showAudioNoteResult(safe(message).isEmpty() ? "Audio note capture failed." : safe(message), true);
    }

    // Abort a capture in flight without uploading. Used when the surfaces are
    // dismissed, record mode is switched off mid-hold, or the service dies.
    private void cancelAudioNoteCapture() {
        if (!audioNoteActive && audioNoteCapture == null) {
            return;
        }
        audioNoteActive = false;
        MoaAudioCaptureController capture = audioNoteCapture;
        audioNoteCapture = null;
        if (capture != null) {
            capture.stop();
        }
        audioNoteBuffer = null;
        if (orbView != null) {
            orbView.setRecordingNote(false);
        }
    }

    private void uploadAudioNote(byte[] audio, boolean capReached) {
        long durationMs = (long) audio.length * 1000L / AUDIO_NOTE_BYTES_PER_SECOND;
        long seconds = Math.max(1L, Math.round(durationMs / 1000.0));
        String sessionId = conversationId.isEmpty() ? MoaPrefs.conversationId(this) : conversationId;
        Map<String, String> metadata = new HashMap<>();
        metadata.put("x-moa-surface", "android-overlay");
        metadata.put("x-moa-session-id", sessionId);
        metadata.put("x-moa-duration-ms", Long.toString(durationMs));
        String storedMessage = "Note stored (" + seconds + "s)"
                + (capReached ? " - hit the 5 minute cap." : "");
        new Thread(() -> {
            try {
                gatewayClient().uploadAudioNote(audio, AUDIO_NOTE_CONTENT_TYPE, metadata);
                mainHandler.post(() -> showAudioNoteResult(storedMessage, false));
            } catch (Exception error) {
                Log.w(TAG, "audio note upload failed: " + cleanError(error));
                String keptPath = keepAudioNoteLocally(audio);
                mainHandler.post(() -> showAudioNoteResult(
                        keptPath.isEmpty()
                                ? "Note upload failed, and keeping it locally also failed."
                                : "Note upload failed, kept locally.",
                        true
                ));
            }
        }, "moa-audio-note-upload").start();
    }

    // Failed uploads keep the raw bytes under files/audio-notes/ so nothing
    // spoken is lost. Returns the file path, or "" when the write failed too.
    private String keepAudioNoteLocally(byte[] audio) {
        try {
            File directory = new File(getFilesDir(), "audio-notes");
            if (!directory.exists() && !directory.mkdirs()) {
                return "";
            }
            File file = new File(directory, System.currentTimeMillis() + ".pcm");
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(audio);
            }
            return file.getAbsolutePath();
        } catch (Exception error) {
            Log.w(TAG, "failed to keep audio note locally: " + cleanError(error));
            return "";
        }
    }

    private void showAudioNoteResult(String message, boolean failed) {
        // Start a fresh turn boundary (keeps prior rows) then append the result
        // as a persistent row; the note result stays until dismissed or swiped.
        resetVoiceTurnTranscript();
        showTranscriptOverlay("");
        updateVoiceAssistantTranscript(message);
        setVoiceRuntimeState(failed ? VoiceRuntimeState.ERROR : VoiceRuntimeState.READY);
        updateMicState();
    }

    private void startLocalVoiceTurn(boolean manualCommitOnly, boolean reviewableDraft) {
        // The local SpeechRecognizer path does not use our AudioRecord, so a mic
        // warmed by the gesture would leak (indicator stuck on). Drop it here.
        discardWarmMic();
        setContinuousVoiceLoop(reviewableDraft);
        cancelContinuousVoiceRestart();
        if (streamingVoiceActive()) {
            cancelStreamingVoice();
        }
        cancelVoiceSampler();
        if (orbView != null) {
            orbView.setHeld(true);
        }
        nextManualVoiceFollowUpRunId = scopedFollowUpRunId();
        nextStreamingVoiceFollowUpRunId = nextManualVoiceFollowUpRunId;
        resetVoiceTurnTranscript();
        showTranscriptOverlay("");
        setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
        voiceController.startCommandListening(manualCommitOnly);
    }

    private boolean streamingVoiceAvailable() {
        return !safe(gatewayUrl).isEmpty() && !safe(gatewayToken).isEmpty();
    }

    // Stop the in-flight streaming controller and its timers WITHOUT removing the
    // transcript card, so a persistent notice (e.g. a timeout) can be shown in
    // place. Mirrors cancelStreamingVoice minus the card teardown.
    private void stopStreamingVoiceKeepingCard() {
        pushToTalkVoiceTurn = false;
        setContinuousVoiceLoop(false);
        suppressFirstTapTurnEmptyCue = false;
        invalidatePendingBranchSwitch();
        cancelContinuousVoiceRestart();
        cancelStreamingTurnWatchdog();
        boolean controllerPresent = streamingVoiceController != null;
        streamingVoiceGeneration = voiceFailureRetry.invalidateForIntentionalTeardown(
                streamingVoiceGeneration,
                controllerPresent);
        if (controllerPresent) {
            // Make callbacks from this intentional teardown stale before close.
            streamingVoiceController.cancel();
            streamingVoiceController = null;
            nextStreamingVoiceFollowUpRunId = "";
        }
        // Deliberately does NOT call voiceController.stopQuietly(): on the
        // streaming path the local recognizer is idle, and stopQuietly would
        // fire onRemoveTranscript and tear the card down.
    }

    private void cancelStreamingVoice() {
        liveConversation.clear();
        pushToTalkVoiceTurn = false;
        setContinuousVoiceLoop(false);
        suppressFirstTapTurnEmptyCue = false;
        invalidatePendingBranchSwitch();
        cancelContinuousVoiceRestart();
        cancelStreamingTurnWatchdog();
        boolean controllerPresent = streamingVoiceController != null;
        streamingVoiceGeneration = voiceFailureRetry.invalidateForIntentionalTeardown(
                streamingVoiceGeneration,
                controllerPresent);
        if (controllerPresent) {
            // A discard, replacement, or card close is not a failed voice turn.
            streamingVoiceController.cancel();
            streamingVoiceController = null;
            nextStreamingVoiceFollowUpRunId = "";
            removeTranscriptOverlay();
            updateMicState();
            return;
        }
        voiceController.stopQuietly();
    }

    private void cancelVoiceSampler() {
        if (voiceSamplePlayer != null) {
            voiceSamplePlayer.destroy();
            voiceSamplePlayer = null;
        }
    }

    private void startStreamingVoiceTurn(boolean autoCommitOnSilence) {
        startStreamingVoiceTurn(autoCommitOnSilence, false);
    }

    private void startReviewableVoiceDraft() {
        if (!streamingVoiceAvailable()) {
            startLocalVoiceTurn(true, true);
            return;
        }
        // Tap-created drafts never use silence auto-commit. The matching orb
        // toggle commits; triple-click cancels locally before opening chat.
        // Continuous here means the draft remains the active voice surface,
        // not that it auto-rearms after reply.
        startStreamingVoiceTurn(false, true);
    }

    private void startStreamingVoiceTurn(boolean autoCommitOnSilence, boolean continuousLoop) {
        loadSettings();
        voiceFailureRetry.invalidate();
        // Any prior in-flight branch switch is now stale, and a fresh start
        // clears any pending commit-on-open.
        invalidatePendingBranchSwitch();
        // The default branch opens with no extra round trip. Incognito and a
        // one-shot "new thread" must first resolve their branch through
        // /v1/threads/switch, because the streaming WS branch is fixed at session
        // start and cannot change once the socket is open.
        MoaContextControlState.StreamingChoice choice = contextControls.consumeStreamingChoice();
        if (choice.consumedNewThread) {
            refreshContextControls();
        }
        if (!choice.requiresBranchSwitch()) {
            openStreamingVoiceSession(autoCommitOnSilence, continuousLoop, activeBranchId, false);
            return;
        }
        resolveThreadBranchThenOpenStreamingVoice(autoCommitOnSilence, continuousLoop, choice.action);
    }

    private void resolveThreadBranchThenOpenStreamingVoice(boolean autoCommit, boolean continuous, String action) {
        final boolean incognito = "incognito".equals(action);
        cancelContinuousVoiceRestart();
        cancelStreamingTurnWatchdog();
        if (streamingVoiceController != null) {
            streamingVoiceController.destroy();
            streamingVoiceController = null;
        }
        showTranscriptOverlay("");
        setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
        updateMicState();
        final int token = ++streamingSwitchToken;
        streamingBranchSwitchPending = true;
        streamingCommitPendingOpen = false;
        final String switchSession = conversationId.isEmpty() ? MoaPrefs.conversationId(this) : conversationId;
        final String url = gatewayUrl;
        final String authToken = gatewayToken;
        final String deviceId = androidDeviceId();
        new Thread(() -> {
            String branch = "";
            try {
                JSONObject body = new JSONObject();
                body.put("session_id", switchSession);
                body.put("action", action);
                body.put("surface", "android-overlay");
                body.put("device_id", deviceId);
                JSONObject switchResponse = new MoaGatewayClient(url, authToken).switchThread(body);
                branch = MoaGatewayClient.branchIdFromSwitch(switchResponse);
            } catch (Exception error) {
                Log.w(TAG, "threads/switch failed: " + cleanError(error));
            }
            final String resolvedBranch = branch;
            mainHandler.post(() -> {
                if (token != streamingSwitchToken) {
                    return;
                }
                streamingBranchSwitchPending = false;
                boolean switchOk = !resolvedBranch.isEmpty();
                if (!switchOk) {
                    streamingCommitPendingOpen = false;
                    pushToTalkVoiceTurn = false;
                    if (orbView != null) {
                        orbView.setHeld(false);
                    }
                    String notice = incognito
                            ? "Couldn't start a private turn. Try again."
                            : "Couldn't start a new thread. Try again.";
                    showTranscriptOverlay("");
                    showStreamingVoiceFailure(
                            notice,
                            streamingVoiceGeneration);
                    return;
                }
                if (!incognito) {
                    updateActiveBranchId(resolvedBranch);
                }
                openStreamingVoiceSession(autoCommit, continuous, resolvedBranch, incognito);
            });
        }, "moa-thread-switch").start();
    }

    private void invalidatePendingBranchSwitch() {
        streamingSwitchToken++;
        streamingBranchSwitchPending = false;
        streamingCommitPendingOpen = false;
    }

    private void openStreamingVoiceSession(boolean autoCommitOnSilence, boolean continuousLoop, String branchId, boolean incognito) {
        loadSettings();
        Log.i(TAG, "openStreamingVoiceSession autoCommit=" + autoCommitOnSilence
                + " continuousLoop=" + continuousLoop
                + " branch=" + safe(branchId)
                + " incognito=" + incognito
                + " gatewayConfigured=" + !safe(gatewayUrl).isEmpty()
                + " token=" + (safe(gatewayToken).isEmpty() ? "missing" : "set"));
        cancelContinuousVoiceRestart();
        cancelStreamingTurnWatchdog();
        if (streamingVoiceController != null) {
            streamingVoiceController.destroy();
        }
        setContinuousVoiceLoop(continuousLoop);
        streamingTurnAutoCommit = autoCommitOnSilence;
        streamingTurnContinuous = continuousLoop;
        streamingTurnRetried = false;
        streamingTurnIncognito = incognito;
        final int generation = ++streamingVoiceGeneration;
        currentStreamingTurnRouted = false;
        currentStreamingTurnCommitRequested = false;
        currentStreamingAssistantRecorded = false;
        currentStreamingTranscript = "";
        streamingTranscriptAccumulator.reset();
        streamingAssistantAudioPlaying = false;
        currentStreamingTurnAudioReceived = false;
        resetVoiceTurnTranscript();
        final String stableSessionId = conversationId.isEmpty() ? MoaPrefs.conversationId(this) : conversationId;
        updateConversationId(stableSessionId);
        final String sessionBranch = safe(branchId).isEmpty() ? "default" : safe(branchId);
        streamingVoiceController = new MoaStreamingVoiceSessionController(gatewayUrl, gatewayToken, MoaPrefs.spokenRepliesEnabled(this), stableSessionId, sessionBranch, autoCommitOnSilence, new MoaStreamingVoiceSessionController.Callback() {
            @Override
            public void onSessionStarted(String sessionId, String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                updateConversationId(sessionId);
                liveConversation.begin(turnId);
                showTranscriptOverlay("");
                renderVoiceTranscriptRows();
                setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
                updateMicState();
            }
            @Override
            public void onSessionReady(String sessionId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                if (voiceRuntimeState == VoiceRuntimeState.SENDING || currentStreamingTurnCommitRequested) {
                    markStreamingTurnProgressing();
                } else {
                    setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
                }
                updateMicState();
            }
            @Override
            public void onRecordingStarted() {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
                updateMicState();
            }
            @Override
            public void onAudioCaptured() {
                if (isCurrentStreamingGeneration(generation) && pushToTalkVoiceTurn) {
                    pushToTalkFinish.audioObserved();
                }
            }

            @Override
            public void onRecordingStopped() {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                currentStreamingTurnCommitRequested = true;
                liveConversation.awaitAssistant(streamingVoiceController == null
                        ? "" : streamingVoiceController.turnId());
                renderVoiceTranscriptRows();
                if (shouldRouteStreamingTranscriptThroughMoa(currentStreamingTranscript)) {
                    routeStreamingTranscriptThroughMoa(currentStreamingTranscript);
                    return;
                }
                setVoiceRuntimeState(VoiceRuntimeState.SENDING);
                armStreamingTurnWatchdog(generation);
                updateMicState();
            }
            @Override
            public void onTranscriptPartial(String turnId, String text) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                markStreamingTurnProgressing();
                String transcript = streamingTranscriptAccumulator.update(text);
                currentStreamingTranscript = safe(transcript);
                liveConversation.updateUserPartial(turnId, currentStreamingTranscript);
                updateVoiceUserTranscript(currentStreamingTranscript, currentStreamingTurnCommitRequested);
                setVoiceRuntimeState(currentStreamingTurnCommitRequested ? VoiceRuntimeState.THINKING : VoiceRuntimeState.LISTENING);
                if (currentStreamingTurnCommitRequested && shouldRouteStreamingTranscriptThroughMoa(currentStreamingTranscript)) {
                    routeStreamingTranscriptThroughMoa(currentStreamingTranscript);
                }
            }
            @Override
            public void onTranscriptFinal(String turnId, String text) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                markStreamingTurnProgressing();
                String transcript = safe(streamingTranscriptAccumulator.update(text));
                if (!transcript.isEmpty()) {
                    currentStreamingTranscript = transcript;
                    liveConversation.finalizeUser(turnId, transcript);
                    renderVoiceTranscriptRows();
                    if (!nextStreamingVoiceFollowUpRunId.isEmpty()) {
                        String followUpRunId = nextStreamingVoiceFollowUpRunId;
                        currentStreamingTurnRouted = true;
                        nextStreamingVoiceFollowUpRunId = "";
                        addMessage(false, transcript);
                        updateVoiceUserTranscript(transcript, true);
                        requestAgentRunFollowUp(followUpRunId, transcript, true);
                    } else if (shouldRouteStreamingTranscriptThroughMoa(transcript)) {
                        routeStreamingTranscriptThroughMoa(transcript);
                    } else {
                        addMessage(false, transcript);
                        updateVoiceUserTranscript(transcript, true);
                    }
                }
            }
            @Override
            public void onAssistantText(String turnId, String text) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                markStreamingTurnProgressing();
                if (currentStreamingTurnRouted) {
                    return;
                }
                if (!safe(text).isEmpty()) {
                    liveConversation.setAssistantFullText(turnId, text);
                    // Streamed assistant text is the reply arriving: show the agent
                    // responding on the orb even for a text-only turn (no audio),
                    // rather than leaving it stuck on THINKING.
                    updateVoiceAssistantTranscript(text);
                    setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
                }
            }
            @Override
            public void onAssistantAudioStarted(String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                // Audio started: re-arm (do NOT cancel) the watchdog. Each audio
                // frame re-arms it again, so a mid-stream stall surfaces the
                // visible timeout in ~30s instead of hanging on the gateway's own
                // 60s backstop.
                resetStreamingTurnWatchdog();
                if (currentStreamingTurnRouted) {
                    return;
                }
                streamingAssistantAudioPlaying = true;
                liveConversation.startAssistantPlayback(turnId);
                renderVoiceTranscriptRows();
                setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
                updateMicState();
            }
            @Override
            public void onAssistantAudioChunk(String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                currentStreamingTurnAudioReceived = true;
                // Keep the watchdog pushed out while audio keeps flowing; the gap
                // between frames is ~40ms, so 30s of silence is a genuine stall.
                // Guarded on active playback so a stray late frame never re-arms a
                // watchdog after the turn has already finished.
                if (streamingAssistantAudioPlaying) {
                    resetStreamingTurnWatchdog();
                }
            }
            @Override
            public void onAssistantPlaybackProgress(String turnId, String text, int spokenChars) {
                if (!isCurrentStreamingGeneration(generation) || currentStreamingTurnRouted) return;
                if (liveConversation.advanceAssistantPlayback(turnId, text, spokenChars)) {
                    renderVoiceTranscriptRows();
                }
            }
            @Override
            public void onTurnProgress(String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                // Gateway keepalive during a long reasoning / TTS leg: re-arm the
                // watchdog and promote the visible state past "sending".
                markStreamingTurnProgressing();
            }
            @Override
            public void onAssistantAudioDone(String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                // Playback finished but turn_done has not arrived yet: re-arm the
                // watchdog so a hang after audio still surfaces a notice.
                resetStreamingTurnWatchdog();
                if (currentStreamingTurnRouted) {
                    return;
                }
                streamingAssistantAudioPlaying = false;
                liveConversation.finishAssistantPlayback(turnId, "");
                renderVoiceTranscriptRows();
                MoaTtsRecoveryQueue.Request recovery = ttsRecoveryQueue.onPlaybackDrained(turnId);
                if (recovery != null) {
                    startQueuedTtsRecovery(recovery, generation);
                    return;
                }
                setVoiceRuntimeState(VoiceRuntimeState.READY);
                if (pendingContinuousVoiceRestartAfterAudio) {
                    pendingContinuousVoiceRestartAfterAudio = false;
                    showReadyForNextVoiceTurn(generation);
                }
            }
            @Override
            public void onTurnDone(String turnId, String status, boolean transcriptionOnly,
                    boolean ttsSpoke, String replyLanguage, JSONObject terminalEvent) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                voiceInvocationLatched = false;
                cancelStreamingTurnWatchdog();
                if (!streamingAssistantAudioPlaying && !currentStreamingTurnAudioReceived) {
                    liveConversation.finishAssistantPlayback(turnId, "");
                    renderVoiceTranscriptRows();
                }
                // turn_done carries the language the assistant actually replied in.
                // Persist it for the session so the header's "Speaks" segment stays
                // live even after the turn; falls back to the profile when absent.
                String replyShort = MoaPrefs.shortLanguageTag(replyLanguage);
                if (!replyShort.isEmpty()) {
                    sessionSpeakLanguage = replyShort;
                    updateVoiceHeaderState();
                }
                if (transcriptionOnly && !currentStreamingTurnRouted && !currentStreamingTranscript.isEmpty()) {
                    routeStreamingTranscriptThroughMoa(currentStreamingTranscript, !voiceUserTranscriptFinal);
                    return;
                }
                if (!currentStreamingTurnRouted) {
                    nextStreamingVoiceFollowUpRunId = "";
                    recordCurrentStreamingAssistant();
                    if (streamingTurnIncognito) {
                        markCurrentReplyNotSaved();
                    }
                }
                String turnStatus = safe(status);
                if ("completed".equals(turnStatus)) {
                    MoaTtsRecoveryPlan recovery = MoaTtsRecoveryPlan.fromTurnDone(
                            terminalEvent, voiceAssistantTranscript);
                    if (MoaPrefs.spokenRepliesEnabled(OverlayService.this) && recovery.shouldRetry()) {
                        pendingContinuousVoiceRestartAfterAudio = false;
                        setVoiceRuntimeState(VoiceRuntimeState.RECOVERING);
                        String retryId = UUID.randomUUID().toString();
                        MoaTtsRecoveryQueue.Request ready = ttsRecoveryQueue.onTerminal(
                                turnId, retryId, recovery.fromTextChar,
                                currentStreamingTurnAudioReceived);
                        updateMicState();
                        if (ready != null) {
                            startQueuedTtsRecovery(ready, generation);
                        }
                        // If prefix playback is still buffered, retry remains
                        // queued until onAssistantAudioDone is delivered after
                        // the AudioTrack playback head reaches its written head.
                        return;
                    }
                    // Local TTS is disabled by policy (hosted audio only), so this
                    // returns false. Kept as the single seam for the on-device
                    // engine; a text-only reply is handled by the not-spoken cue.
                    boolean fallbackSpeaking = maybeSpeakStreamingFallback(ttsSpoke, replyLanguage);
                    refreshVoiceProfile();
                    if (fallbackSpeaking) {
                        // Local TTS drives completion via onSpokenReplyFinished.
                        return;
                    }
                    if (streamingAssistantAudioPlaying) {
                        pendingContinuousVoiceRestartAfterAudio = true;
                        return;
                    }
                    boolean gatewaySpoke = ttsSpoke && currentStreamingTurnAudioReceived;
                    if (!gatewaySpoke) {
                        // Completed, but no spoken audio arrived. Mark the reply
                        // "(not spoken)" and hold it longer so a text-only turn is
                        // read as intentional, not a broken/silent turn.
                        markCurrentReplyNotSpoken();
                        showReadyForNextVoiceTurn(generation, VOICE_NOT_SPOKEN_HOLD_MS);
                        return;
                    }
                    showReadyForNextVoiceTurn(generation);
                    return;
                }
                if ("no_speech".equals(turnStatus)) {
                    liveConversation.clear();
                    if (suppressFirstTapTurnEmptyCue
                            && !currentStreamingTurnRouted
                            && currentStreamingTranscript.isEmpty()
                            && voiceAssistantTranscript.isEmpty()) {
                        // Quiet disarm: the user tapped to talk and said nothing on
                        // this first turn. Fold the loop away without a cue instead
                        // of scolding a barge-in or a stray tap.
                        suppressFirstTapTurnEmptyCue = false;
                        cancelStreamingVoice();
                        voiceLog.clear();
                        removeTranscriptOverlay();
                        updateMicState();
                        return;
                    }
                    String notice = "I didn't catch that.";
                    liveConversation.clear();
                    updateVoiceAssistantTranscript(notice);
                    speakOverlayNotice(notice);
                    setVoiceRuntimeState(VoiceRuntimeState.READY);
                } else if ("error".equals(turnStatus)) {
                    showStreamingVoiceFailure("Voice failed.", generation);
                    return;
                }
                updateMicState();
                mainHandler.postDelayed(() -> {
                    if (isCurrentStreamingGeneration(generation)) {
                        showReadyForNextVoiceTurn(generation);
                    }
                }, 700);
            }
            @Override
            public void onTtsRetryDone(String turnId, String retryId, String status,
                    int fromTextChar, String error) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                if ("completed".equals(safe(status))) {
                    resetStreamingTurnWatchdog();
                    return;
                }
                cancelStreamingTurnWatchdog();
                streamingAssistantAudioPlaying = false;
                markCurrentReplyNotSpoken();
                setVoiceRuntimeState(VoiceRuntimeState.ERROR);
                updateMicState();
                Log.w(TAG, "hosted TTS recovery failed retryId=" + safe(retryId)
                        + " fromTextChar=" + fromTextChar + " error=" + safe(error));
                mainHandler.postDelayed(() -> {
                    if (isCurrentStreamingGeneration(generation)) {
                        showReadyForNextVoiceTurn(generation);
                    }
                }, VOICE_NOT_SPOKEN_HOLD_MS);
            }
            @Override
            public void onSessionClosed() {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                cancelStreamingTurnWatchdog();
                if (currentStreamingTurnRouted) {
                    return;
                }
                // The controller only reports a close for a still-active session,
                // so reaching here means turn_done never arrived. If a turn was
                // committed and in flight, say so instead of resetting silently.
                if (currentStreamingTurnCommitRequested) {
                    currentStreamingTurnCommitRequested = false;
                    showStreamingVoiceFailure("Voice connection dropped.", generation);
                    return;
                }
                if (continuousVoiceLoop && currentStreamingTranscript.isEmpty() && voiceAssistantTranscript.isEmpty()) {
                    setContinuousVoiceLoop(false);
                }
                mainHandler.postDelayed(() -> {
                    if (isCurrentStreamingGeneration(generation)) {
                        showReadyForNextVoiceTurn(generation);
                    }
                }, 700);
            }
            @Override
            public void onError(String message, Throwable error) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                voiceInvocationLatched = false;
                cancelStreamingTurnWatchdog();
                nextStreamingVoiceFollowUpRunId = "";
                Log.w(TAG, "streaming voice error: " + safe(message), error);
                if (isRecoverableStreamingVoiceError(message)) {
                    recoverStreamingVoiceTurn(generation);
                    return;
                }
                // A failure before the user committed anything gets one silent
                // reconnect instead of an error banner: nothing was lost yet.
                if (!currentStreamingTurnCommitRequested
                        && currentStreamingTranscript.isEmpty()
                        && !streamingTurnRetried) {
                    retryStreamingVoiceTurn();
                    return;
                }
                // Raw socket/provider diagnostics stay in logcat. The transcript
                // gets one short line, and errors never land in the chat history.
                String notice = shortVoiceFailureNotice(message);
                showStreamingVoiceFailure(notice, generation);
            }
        }, this);
        if (!pendingReplacementTurnId.isEmpty()) {
            streamingVoiceController.setTurnIdentity(pendingReplacementTurnId, androidDeviceId());
            pendingReplacementTurnId = "";
        } else {
            streamingVoiceController.setTurnIdentity("", androidDeviceId());
        }
        streamingVoiceController.setPrewarmedCapture(adoptWarmMic());
        streamingVoiceController.startSession();
        if (streamingCommitPendingOpen) {
            streamingCommitPendingOpen = false;
            mainHandler.post(this::commitStreamingVoiceTurnNow);
        }
    }

    private boolean isRecoverableStreamingVoiceError(String message) {
        String normalized = safe(message).toLowerCase(Locale.US);
        return normalized.contains("gemini-live generation was interrupted")
                || normalized.contains("failed to complete turn: gemini-live");
    }

    // One silent reconnect for a voice session that failed before the user
    // committed anything. Restarts the same turn shape; the retry budget stays
    // spent so a second failure surfaces normally.
    private void retryStreamingVoiceTurn() {
        Log.i(TAG, "silently retrying streaming voice session after pre-commit failure");
        boolean autoCommit = streamingTurnAutoCommit;
        boolean continuous = streamingTurnContinuous;
        startStreamingVoiceTurn(autoCommit, continuous);
        streamingTurnRetried = true;
    }

    // Raw socket diagnostics carry URLs and HTTP codes; those belong in logcat.
    // The transcript gets one short line, actionable only when the failure is a
    // setup problem the user can fix.
    private String shortVoiceFailureNotice(String message) {
        String normalized = safe(message).toLowerCase(Locale.US);
        if (normalized.contains("token was rejected")) {
            return "Voice can't connect: the gateway rejected this device's token. Re-pair in the AG app.";
        }
        if (normalized.contains("url issue")
                || normalized.contains("not deployed")
                || normalized.contains("could not resolve")) {
            return "Voice can't connect. Check the gateway URL in the AG app.";
        }
        return "Voice failed.";
    }

    private void showStreamingVoiceFailure(String notice, int generation) {
        if (!isCurrentStreamingGeneration(generation)) {
            return;
        }
        setContinuousVoiceLoop(false);
        voiceFailureRetry.arm(generation);
        liveConversation.clear();
        updateVoiceAssistantTranscript(notice);
        speakOverlayNotice(notice);
        setVoiceRuntimeState(VoiceRuntimeState.ERROR);
        updateMicState();
    }

    private void retryFailedVoiceCapture() {
        voiceFailureRetry.consumeAndRun(streamingVoiceGeneration, () -> {
            forcedReviewableVoiceDraft = true;
            renderVoiceTranscriptRows();
            startReviewableVoiceDraft();
        });
    }

    private void recoverStreamingVoiceTurn(int generation) {
        Log.i(TAG, "recovering from interrupted streaming voice turn");
        cancelStreamingTurnWatchdog();
        if (!currentStreamingTurnRouted) {
            recordCurrentStreamingAssistant();
        }
        if (streamingVoiceController != null) {
            streamingVoiceController.destroy();
            streamingVoiceController = null;
        }
        streamingAssistantAudioPlaying = false;
        pendingContinuousVoiceRestartAfterAudio = false;
        setVoiceRuntimeState(VoiceRuntimeState.RECOVERING);
        updateMicState();
        mainHandler.postDelayed(() -> {
            if (isCurrentStreamingGeneration(generation)) {
                showReadyForNextVoiceTurn(generation);
            }
        }, 250);
    }

    private boolean isCurrentStreamingGeneration(int generation) {
        return generation == streamingVoiceGeneration;
    }

    private void resetVoiceTurnTranscript() {
        // A new turn boundary: keep every prior row on screen (persistent stack)
        // and detach the live pointers so the next partials append fresh rows.
        voiceLog.startTurn();
        voiceUserTranscript = "";
        voiceAssistantTranscript = "";
        voiceUserTranscriptFinal = false;
        currentStreamingAssistantRecorded = false;
        ttsRecoveryQueue.clear();
        renderVoiceTranscriptRows();
    }

    private void startQueuedTtsRecovery(MoaTtsRecoveryQueue.Request recovery, int generation) {
        if (!isCurrentStreamingGeneration(generation) || recovery == null) {
            return;
        }
        if (streamingVoiceController != null
                && streamingVoiceController.retryTts(
                        recovery.turnId, recovery.retryId, recovery.fromTextChar)) {
            resetStreamingTurnWatchdog();
            updateMicState();
            return;
        }
        ttsRecoveryQueue.clear();
        streamingAssistantAudioPlaying = false;
        markCurrentReplyNotSpoken();
        setVoiceRuntimeState(VoiceRuntimeState.ERROR);
        updateMicState();
        Log.w(TAG, "hosted TTS recovery could not be queued retryId=" + recovery.retryId);
        mainHandler.postDelayed(() -> {
            if (isCurrentStreamingGeneration(generation)) {
                showReadyForNextVoiceTurn(generation);
            }
        }, VOICE_NOT_SPOKEN_HOLD_MS);
    }

    private void recordCurrentStreamingAssistant() {
        if (currentStreamingAssistantRecorded || voiceAssistantTranscript.isEmpty()) {
            return;
        }
        currentStreamingAssistantRecorded = true;
        addMessage(true, voiceAssistantTranscript);
    }

    private boolean maybeSpeakStreamingFallback(boolean ttsSpoke, String replyLanguage) {
        if (currentStreamingTurnRouted) {
            return false;
        }
        boolean gatewaySpoke = ttsSpoke && currentStreamingTurnAudioReceived;
        if (gatewaySpoke || streamingAssistantAudioPlaying) {
            return false;
        }
        String text = safe(voiceAssistantTranscript);
        if (text.isEmpty()) {
            return false;
        }
        if (!MoaPrefs.spokenRepliesEnabled(this) || voiceController == null || !voiceController.isIdle()) {
            return false;
        }
        String reply = safe(replyLanguage);
        if (!reply.isEmpty()) {
            // Best-effort: bias the on-device voice toward the reply language so
            // a non-English reply reads in the right locale where supported.
            voiceController.setLanguageTags(MoaPrefs.inputLanguageTag(this), reply);
        }
        boolean speaking = voiceController.speak(text);
        if (speaking) {
            setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
            updateMicState();
        }
        return speaking;
    }

    private boolean shouldRouteStreamingTranscriptThroughMoa(String text) {
        return shouldRouteOperationalTurnThroughMoa(text);
    }

    private boolean shouldRouteOperationalTurnThroughMoa(String text) {
        return MoaOperationalTurnRouter.shouldRouteThroughMoa(text);
    }

    private boolean shouldForceAgentForStreamingTranscript(String text) {
        return shouldForceAgentForMoaRoutedTurn(text);
    }

    private boolean shouldForceAgentForMoaRoutedTurn(String text) {
        return MoaOperationalTurnRouter.shouldForceAgent(text);
    }

    private void routeStreamingTranscriptThroughMoa(String text) {
        routeStreamingTranscriptThroughMoa(text, true);
    }

    private void routeStreamingTranscriptThroughMoa(String text, boolean addUserMessage) {
        String transcript = safe(text);
        if (transcript.isEmpty() || currentStreamingTurnRouted) {
            return;
        }
        currentStreamingTurnRouted = true;
        currentStreamingTurnCommitRequested = false;
        cancelStreamingTurnWatchdog();
        nextStreamingVoiceFollowUpRunId = "";
        if (addUserMessage) {
            addMessage(false, transcript);
        }
        updateVoiceUserTranscript(transcript, true);
        setVoiceRuntimeState(VoiceRuntimeState.THINKING);
        requestVoiceTurn(transcript, true, shouldForceAgentForStreamingTranscript(transcript));
        MoaStreamingVoiceSessionController controller = streamingVoiceController;
        if (controller != null) {
            controller.cancel();
        }
        updateMicState();
    }

    private void showReadyForNextVoiceTurn(int generation) {
        showReadyForNextVoiceTurn(generation, VOICE_RESPONSE_HOLD_MS);
    }

    private void showReadyForNextVoiceTurn(int generation, long dismissDelayMs) {
        cancelStreamingTurnWatchdog();
        // The turn is over: voiceLog owns its rows now, so later writes (a
        // notice, a "(not spoken)" marker) are not shadowed by live state.
        liveConversation.clear();
        setVoiceRuntimeState(VoiceRuntimeState.READY);
        updateMicState();
        if (continuousVoiceLoop && generation == streamingVoiceGeneration) {
            scheduleContinuousVoiceRestart(generation);
            return;
        }
        // The completed turn's rows STAY on the card (persistent transcript).
        // dismissDelayMs is retained only for call-site compatibility; the card
        // is now removed only by an explicit dismissal or a swipe.
    }

    private void markCurrentReplyNotSpoken() {
        String text = safe(voiceAssistantTranscript);
        if (text.isEmpty() || text.endsWith(NOT_SPOKEN_SUFFIX)) {
            return;
        }
        liveConversation.clear();
        updateVoiceAssistantTranscript(text + NOT_SPOKEN_SUFFIX);
    }

    private void markCurrentReplyNotSaved() {
        String marked = MoaContextControlState.appendNotSaved(voiceAssistantTranscript);
        if (!marked.equals(safe(voiceAssistantTranscript))) {
            liveConversation.clear();
            updateVoiceAssistantTranscript(marked);
        }
    }

    private boolean isVoiceInvocation(Intent intent) {
        if (intent == null) {
            return false;
        }
        return intent.getBooleanExtra(EXTRA_START_VOICE, false)
                || ACTION_ASSIST_BUTTON.equals(intent.getAction());
    }

    private boolean streamingVoiceActive() {
        return streamingVoiceController != null && streamingVoiceController.isActive();
    }

    private void beginWarmMic() {
        if (!streamingVoiceAvailable()) {
            return;
        }
        if (warmMic == null) {
            warmMic = new MoaAudioCaptureController();
        }
        if (!warmMic.isRecording()) {
            warmMic.warmUp();
        }
    }

    private void discardWarmMic() {
        if (warmMic != null) {
            warmMic.stop();
            warmMic = null;
        }
    }

    private MoaAudioCaptureController adoptWarmMic() {
        MoaAudioCaptureController mic = warmMic;
        warmMic = null;
        return mic;
    }

    private void updateMicState() {
        if (orbView != null) {
            orbView.setListening(voiceController.isActive() || streamingVoiceActive() || voiceSamplePlayer != null);
        }
    }

    private TextView pill(String text, int background, int foreground) {
        return MoaTextViews.pill(this, text, background, foreground);
    }

    private TextView text(String text, int color, int sp, boolean bold) {
        return MoaTextViews.text(this, text, color, sp, bold);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

}

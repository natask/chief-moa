package ai.moa.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.view.ActionMode;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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
    static final String EXTRA_START_VOICE = "ai.moa.assistant.extra.START_VOICE";

    private static final int MAX_HISTORY_MESSAGES = 50;
    private static final int MAX_GATEWAY_MESSAGES = 24;
    private static final int MAX_AGENT_PROMPT_CHARS = 12000;
    private static final int ORB_WINDOW_DP = 96;
    private static final int ORB_EDGE_MARGIN_DP = 16;
    private static final int OVERLAY_NOTIFICATION_ID = 5701;
    private static final long VOICE_RESPONSE_HOLD_MS = 1200;
    private static final long VOICE_NOT_SPOKEN_HOLD_MS = 5000;
    private static final String NOT_SPOKEN_SUFFIX = "\n\n(not spoken)";
    private static final long STREAMING_TURN_WATCHDOG_MS = 30000;
    private static final long CONTINUOUS_VOICE_RESTART_MS = 420;
    private static final long DEVICE_CLIENT_POLL_MS = 2500;
    private static final String OVERLAY_CHANNEL_ID = "moa_overlay";
    private static final int AUDIO_NOTE_BYTES_PER_SECOND =
            MoaAudioCaptureController.SAMPLE_RATE_HZ * 2 * MoaAudioCaptureController.CHANNEL_COUNT;
    private static final int AUDIO_NOTE_MAX_BYTES = AUDIO_NOTE_BYTES_PER_SECOND * 300;
    private static final String AUDIO_NOTE_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<ChatMessage> messages = new ArrayList<>();

    private MoaActionBroker actionBroker;
    private WindowManager windowManager;
    private OrbView orbView;
    private WindowManager.LayoutParams orbParams;
    private WindowManager.LayoutParams panelParams;
    private WindowManager.LayoutParams transcriptParams;
    private MoaFrameCoalescer orbDragFrameCoalescer;
    private View orbRemoveTarget;
    private boolean orbRemoveTargetActive;
    private View panelView;
    private LinearLayout messageColumn;
    private ScrollView messageScroll;
    private EditText composer;
    private TextView runStatusView;
    private View transcriptView;
    private LinearLayout voiceTranscriptColumn;
    private ScrollView voiceTranscriptScroll;
    private TextView voiceMetaLine;
    private TextView voiceLanguageLine;
    private boolean transcriptSelectionActive;
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
    private boolean animateNextAssistantRow;
    private boolean currentStreamingAssistantRecorded;
    private String sessionSpeakLanguage = "";
    private String sessionHearLanguages = "";
    private Runnable pendingAutoDismiss;
    private Runnable pendingContinuousVoiceRestart;
    private Runnable pendingStreamingTurnWatchdog;
    private boolean streamingTurnAutoCommit;
    private boolean streamingTurnContinuous;
    private boolean streamingTurnRetried;
    private MoaVoiceController voiceController;
    private MoaStreamingVoiceSessionController streamingVoiceController;
    private String pendingReplacementTurnId = "";
    private boolean nextVoiceCaptureFreshThread;
    private MoaVoiceSamplePlayer voiceSamplePlayer;
    private boolean panelOpen;
    private boolean nextVoiceRunsAgent;
    private static volatile boolean running;
    private String gatewayUrl = "";
    private String gatewayToken = "";
    private String conversationId = "";
    private boolean currentStreamingTurnRouted;
    private boolean currentStreamingTurnCommitRequested;
    private String currentStreamingTranscript = "";
    private final MoaSpeechTranscriptAccumulator streamingTranscriptAccumulator = new MoaSpeechTranscriptAccumulator();
    private final MoaAgentRunTracker agentRuns = new MoaAgentRunTracker();
    private boolean agentRunPolling;
    private boolean nextManualVoiceFollowsActiveRun;
    private boolean nextStreamingTurnFollowsActiveRun;
    private int streamingVoiceGeneration;
    private boolean continuousVoiceLoop;
    private boolean suppressFirstTapTurnEmptyCue;
    private boolean pushToTalkVoiceTurn;
    private boolean recordModeEnabled;
    private MoaVoiceFirstTapResolver.CaptureOrigin manualTapCaptureOrigin =
            MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
    private boolean audioNoteActive;
    private MoaAudioCaptureController audioNoteCapture;
    private ByteArrayOutputStream audioNoteBuffer;
    private MoaAudioCaptureController warmMic;
    private TextView recordModePill;
    private final MoaContextControlState contextControls = new MoaContextControlState();
    private TextView newThreadPill;
    private TextView incognitoPill;
    private LinearLayout contextControlsRow;
    private boolean streamingTurnIncognito;
    private int streamingSwitchToken;
    private boolean streamingBranchSwitchPending;
    private boolean streamingCommitPendingOpen;
    private boolean pendingContinuousVoiceRestartAfterAudio;
    private boolean streamingAssistantAudioPlaying;
    private boolean currentStreamingTurnAudioReceived;
    private boolean deviceClientLoopRunning;
    private boolean deviceClientPollInFlight;

    private enum VoiceRuntimeState {
        READY,
        LISTENING,
        SENDING,
        THINKING,
        SPEAKING,
        INTERRUPTED,
        RECOVERING,
        ERROR
    }

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
                + " startVoice=" + shouldStartVoice(intent));
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
        if (ACTION_COLLAPSE_SURFACES.equals(intent != null ? intent.getAction() : null)) {
            collapseInteractiveSurfaces();
            return START_STICKY;
        }
        if (shouldStartVoice(intent)) {
            mainHandler.post(this::startContinuousStreamingVoiceTurn);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        String pendingToolRequest = toolRequestGate.active();
        if (!pendingToolRequest.isEmpty()) finishClaimedToolRequest(pendingToolRequest,
                new ToolRequestExecution(false, "Overlay stopped before the local action completed.", null));
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
                "A.G. overlay",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the A.G. overlay available above other apps.");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);

        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private Notification overlayNotification() {
        Intent intent = new Intent(this, MainActivity.class);
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
                .setContentTitle("A.G. overlay")
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
        if (!Settings.canDrawOverlays(this) || orbView != null) {
            return;
        }

        int size = dp(ORB_WINDOW_DP);
        orbView = new OrbView(this);
        applyCachedPetVisualState();
        orbParams = new WindowManager.LayoutParams(
                size,
                size,
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        orbParams.gravity = Gravity.TOP | Gravity.START;
        orbParams.x = getResources().getDisplayMetrics().widthPixels - size - dp(ORB_EDGE_MARGIN_DP);
        orbParams.y = dp(164);
        orbDragFrameCoalescer = new MoaFrameCoalescer(
                new MoaViewFrameScheduler(orbView), this::applyLatestOrbDragFrame);
        orbView.setOnTouchListener(new MoaOrbTouchListener(
                this,
                orbParams,
                size,
                ORB_EDGE_MARGIN_DP,
                this::handleOrbSingleTap,
                this::handleOrbDoublePressStart,
                this::handleOrbVoicePressRelease,
                this::beginWarmMic,
                this::discardWarmMic,
                () -> MoaPrefs.voiceFirstGestures(this),
                this::manualTapCaptureOrigin,
                this::handleOrbStartTalkLoop,
                this::handleOrbStopAndSend,
                this::handleOrbStartFreshTalkLoop,
                this::handleOrbCancelTalkLoop,
                this::showPanel,
                this::handleOrbPushToTalkCancel,
                this::showOrbRemoveTarget,
                this::updateOrbDragSurfaces,
                this::finishOrbDrag
        ));

        windowManager.addView(orbView, orbParams);
    }

    private void removeOrb() {
        if (orbView != null) {
            windowManager.removeView(orbView);
            orbView = null;
        }
    }

    private void positionSurfaceNearOrb(View surface, WindowManager.LayoutParams params) {
        if (surface == null || params == null || orbParams == null) {
            return;
        }
        int screenWidth = getResources().getDisplayMetrics().widthPixels;
        int screenHeight = getResources().getDisplayMetrics().heightPixels;
        int margin = dp(10);
        int orbSize = orbParams.width > 0 ? orbParams.width : dp(ORB_WINDOW_DP);
        int surfaceWidth = params.width > 0 ? params.width : Math.min(screenWidth - margin * 2, dp(380));
        MoaOverlayWindowLayout.positionAnchored(
                windowManager, surface, params, screenWidth, screenHeight, margin, dp(12),
                orbView, orbParams, orbSize, surfaceWidth,
                surface == panelView ? dp(430) : dp(180));
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
                if (v == panelView) {
                    positionSurfaceNearOrb(panelView, panelParams);
                } else if (v == transcriptView) {
                    positionSurfaceNearOrb(transcriptView, transcriptParams);
                }
            });
        });
    }
    private void updateAnchoredSurfacePositions() {
        applyLatestOrbDragFrame();
    }

    private void attachSurfaceHeaderDrag(View header) {
        if (header == null || orbView == null || orbParams == null) return;
        header.setOnTouchListener(new MoaOverlayGroupDragListener(
                this, windowManager, orbView, orbParams, dp(ORB_WINDOW_DP),
                dp(ORB_EDGE_MARGIN_DP), this::hideKeyboard, this::updateAnchoredSurfacePositions));
    }

    private void showOrbRemoveTarget() {
        if (orbRemoveTarget != null || !Settings.canDrawOverlays(this)) {
            return;
        }
        orbRemoveTarget = MoaOrbRemoveTarget.show(this, windowManager, overlayType());
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
        // Anchor the open surface FIRST: the always-above rule may push the orb
        // down, and the draft controls and orb window below must lay out from
        // that settled position so the whole ensemble moves as one frame.
        if (panelView != null) {
            positionSurfaceNearOrb(panelView, panelParams);
        } else if (transcriptView != null) {
            positionSurfaceNearOrb(transcriptView, transcriptParams);
        }
        prepareVoiceDraftControlPositions();
        MoaOverlayWindowLayout.update(windowManager, orbView, orbParams);
        updatePreparedVoiceDraftControlLayouts();
        updateOrbRemoveTargetState();
    }

    private void updateOrbRemoveTargetState() {
        if (!(orbRemoveTarget instanceof TextView) || orbParams == null) {
            return;
        }
        int screenWidth = getResources().getDisplayMetrics().widthPixels;
        int screenHeight = getResources().getDisplayMetrics().heightPixels;
        int orbSize = orbParams.width > 0 ? orbParams.width : dp(ORB_WINDOW_DP);
        boolean active = MoaOrbOverlayGeometry.isInRemoveTarget(
                screenWidth,
                screenHeight,
                orbParams.x,
                orbParams.y,
                orbSize,
                dp(170),
                dp(135)
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
        if (remove) {
            // Dropping on the removal target dismisses the WHOLE overlay as one
            // gesture: every window is detached in this same call — no exit
            // animations, no posted teardown — so the orb never vanishes while a
            // card or control visibly lingers behind it.
            removeAllOverlayWindowsNow();
            stopSelf();
        }
    }

    private void removeAllOverlayWindowsNow() {
        hideKeyboard();
        View panel = panelView;
        panelView = null;
        panelParams = null;
        panelOpen = false;
        messageColumn = null;
        messageScroll = null;
        composer = null;
        runStatusView = null;
        recordModePill = null;
        newThreadPill = null;
        incognitoPill = null;
        contextControlsRow = null;
        MoaOverlayWindowLayout.detach(windowManager, panel);
        cancelAutoDismiss();
        View transcript = transcriptView;
        transcriptView = null;
        transcriptParams = null;
        voiceTranscriptColumn = null;
        voiceTranscriptScroll = null;
        voiceMetaLine = null;
        voiceLanguageLine = null;
        MoaOverlayWindowLayout.detach(windowManager, transcript);
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

    private void togglePanel() {
        if (panelOpen) {
            removePanel();
        } else {
            showPanel();
        }
    }

    private void showPanel() {
        if (!Settings.canDrawOverlays(this) || panelView != null) {
            return;
        }

        removeTranscriptOverlay();
        loadSettings();

        panelView = createPanel();
        int width = Math.min(getResources().getDisplayMetrics().widthPixels - dp(20), dp(380));
        panelParams = new WindowManager.LayoutParams(
                width,
                WindowManager.LayoutParams.WRAP_CONTENT,
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        // The surface follows the orb and stays wholly above it; when there is
        // not enough room the ORB is pushed down, never the card below. The IME
        // does not resize overlay windows, so positioning is kept independent
        // from keyboard animation.
        panelParams.gravity = Gravity.TOP | Gravity.START;
        panelParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;

        panelView.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == android.view.MotionEvent.ACTION_OUTSIDE) {
                dismissOverlayUi();
                return true;
            }
            return false;
        });

        positionSurfaceNearOrb(panelView, panelParams);
        keepSurfaceAnchoredOnRemeasure(panelView);
        windowManager.addView(panelView, panelParams);
        panelOpen = true;
        panelView.post(() -> positionSurfaceNearOrb(panelView, panelParams));
        renderMessages();
        MoaOverlayWindowLayout.animateIn(panelView, dp(18));
        mainHandler.postDelayed(() -> {
            if (composer == null) {
                return;
            }
            composer.requestFocus();
            InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (inputMethodManager != null) {
                inputMethodManager.showSoftInput(composer, InputMethodManager.SHOW_IMPLICIT);
            }
        }, 180);
    }

    private void removePanel() {
        if (panelView == null) {
            return;
        }
        hideKeyboard();
        final View dying = panelView;
        panelView = null;
        panelParams = null;
        panelOpen = false;
        messageColumn = null;
        messageScroll = null;
        composer = null;
        runStatusView = null;
        recordModePill = null;
        newThreadPill = null;
        incognitoPill = null;
        contextControlsRow = null;
        dying.animate()
                .alpha(0f)
                .translationY(dp(14))
                .scaleX(0.97f)
                .scaleY(0.97f)
                .setDuration(130)
                .setInterpolator(new android.view.animation.AccelerateInterpolator())
                .withEndAction(() -> MoaOverlayWindowLayout.detach(windowManager, dying))
                .start();
    }

    private void hideKeyboard() {
        InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (inputMethodManager != null && composer != null) {
            inputMethodManager.hideSoftInputFromWindow(composer.getWindowToken(), 0);
        }
    }

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
        if (transcriptView != null) {
            renderVoiceTranscriptRows();
            return;
        }
        cancelAutoDismiss();
        removePanel();

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(MoaDrawables.roundedGradient(MoaColors.RAISED, MoaColors.PANEL_BG, dp(24), MoaColors.PANEL_BORDER, dp(1)));
        card.setElevation(dp(26));
        card.setPadding(dp(16), dp(14), dp(16), dp(16));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            card.setOutlineSpotShadowColor(0xFF000000);
            card.setOutlineAmbientShadowColor(0xFF000000);
        }

        card.addView(createVoiceHeader());

        voiceTranscriptScroll = new CappedScrollView(this, dp(360));
        voiceTranscriptScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        voiceTranscriptScroll.setVerticalScrollBarEnabled(false);
        voiceTranscriptScroll.setClipToPadding(false);
        voiceTranscriptScroll.setPadding(0, dp(3), 0, 0);

        voiceTranscriptColumn = new LinearLayout(this);
        voiceTranscriptColumn.setOrientation(LinearLayout.VERTICAL);
        voiceTranscriptScroll.addView(voiceTranscriptColumn, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        card.addView(voiceTranscriptScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        renderVoiceTranscriptRows();

        FrameLayout shell = new FrameLayout(this);
        shell.setPadding(dp(16), 0, dp(16), 0);
        shell.addView(card, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        int width = Math.min(getResources().getDisplayMetrics().widthPixels - dp(12), dp(560));
        transcriptParams = new WindowManager.LayoutParams(
                width,
                WindowManager.LayoutParams.WRAP_CONTENT,
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        transcriptParams.gravity = Gravity.TOP | Gravity.START;
        positionSurfaceNearOrb(shell, transcriptParams);
        keepSurfaceAnchoredOnRemeasure(shell);
        windowManager.addView(shell, transcriptParams);
        transcriptView = shell;
        shell.post(() -> positionSurfaceNearOrb(transcriptView, transcriptParams));
        MoaOverlayWindowLayout.animateIn(card, dp(18));
    }

    private View createVoiceHeader() {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(2), 0, dp(2), dp(4));

        PulseDot dot = new PulseDot(this);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(9), dp(9));
        dotParams.rightMargin = dp(10);
        dotParams.gravity = Gravity.CENTER_VERTICAL;
        header.addView(dot, dotParams);

        TextView title = text("Voice", MoaColors.PAPER, 13, true);
        title.setLetterSpacing(0.04f);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        voiceMetaLine = text(agentRunStatusText(), MoaColors.MUTED, 11, false);
        header.addView(voiceMetaLine);
        TextView hide = pill("Hide", 0x16FF453A, 0xFFFFAAA4);
        hide.setContentDescription("Hide the A.G. orb");
        hide.setOnClickListener(v -> stopSelf());
        header.addView(hide);

        // Discoverable whole-card dismiss, matching the chat panel's close pill.
        // Swiping the rows away still works; this closes everything in one tap.
        TextView close = pill("×", 0x16FFFFFF, MoaColors.MUTED);
        close.setContentDescription("Close voice card");
        close.setOnClickListener(v -> dismissOverlayUi());
        header.addView(close);
        attachSurfaceHeaderDrag(header);
        container.addView(header);

        voiceLanguageLine = text("", MoaColors.MUTED, 11, false);
        voiceLanguageLine.setLetterSpacing(0.02f);
        voiceLanguageLine.setPadding(dp(2), 0, dp(2), dp(8));
        container.addView(voiceLanguageLine);

        updateVoiceHeaderState();
        return container;
    }

    private boolean reviewableVoiceDraftActive() {
        return MoaPrefs.voiceFirstGestures(this)
                && continuousVoiceLoop
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
            voiceCancelControlParams = MoaVoiceDraftControls.windowParams(size, overlayType());
            windowManager.addView(voiceCancelControl, voiceCancelControlParams);
        }
        if (voiceSendControl == null) {
            voiceSendControl = MoaVoiceDraftControls.create(
                    this, "↑", "Send voice draft", true, dp(42), dp(1));
            voiceSendControl.setOnClickListener(v -> sendVoiceDraft());
            voiceSendControlParams = MoaVoiceDraftControls.windowParams(size, overlayType());
            windowManager.addView(voiceSendControl, voiceSendControlParams);
        }
    }

    private void updateVoiceDraftControlPositions() {
        prepareVoiceDraftControlPositions();
        MoaOverlayWindowLayout.update(windowManager, orbView, orbParams);
        updatePreparedVoiceDraftControlLayouts();
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
        int orbSize = orbParams.width > 0 ? orbParams.width : dp(ORB_WINDOW_DP);
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
        MoaOverlayWindowLayout.update(windowManager, voiceCancelControl, voiceCancelControlParams);
        MoaOverlayWindowLayout.update(windowManager, voiceSendControl, voiceSendControlParams);
    }

    private void removeVoiceDraftControls() {
        MoaOverlayWindowLayout.detach(windowManager, voiceCancelControl);
        MoaOverlayWindowLayout.detach(windowManager, voiceSendControl);
        voiceCancelControl = null;
        voiceSendControl = null;
        voiceCancelControlParams = null;
        voiceSendControlParams = null;
    }

    private void discardVoiceDraft() {
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
        suppressFirstTapTurnEmptyCue = false;
        continuousVoiceLoop = false;
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
        if (!reviewableVoiceDraftActive()) {
            return;
        }
        manualTapCaptureOrigin = MoaVoiceFirstTapResolver.CaptureOrigin.NONE;
        suppressFirstTapTurnEmptyCue = false;
        continuousVoiceLoop = false;
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
            updateVoiceAssistantTranscript("Screen access is off. Enable it in A.G. settings.");
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
        if (transcriptView == null) {
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
        if (voiceLog.currentAssistantText().isEmpty()) {
            animateNextAssistantRow = true;
        }
        voiceLog.setAssistant(value);
        voiceAssistantTranscript = value;
        if (transcriptView == null) {
            showTranscriptOverlay("");
        }
        setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
        renderVoiceTranscriptRows();
    }

    private void renderVoiceTranscriptRows() {
        if (voiceTranscriptColumn == null) {
            return;
        }
        voiceTranscriptColumn.removeAllViews();
        int count = voiceLog.size();
        for (int i = 0; i < count; i++) {
            MoaVoiceTranscriptLog.Entry entry = voiceLog.get(i);
            boolean assistant = !entry.isUser();
            String rowText = entry.interrupted
                    ? entry.text + "\n\nInterrupted · steering"
                    : entry.text;
            View row = voiceMessageRow(assistant, rowText, entry.finalText);
            attachSwipeDismiss(row, entry);
            voiceTranscriptColumn.addView(row);
            boolean newestAssistant = assistant && i == count - 1;
            if (animateNextAssistantRow && newestAssistant) {
                animateNextAssistantRow = false;
                row.setAlpha(0f);
                row.setTranslationY(dp(8));
                row.animate()
                        .alpha(1f)
                        .translationY(0f)
                        .setDuration(170)
                        .setInterpolator(new android.view.animation.DecelerateInterpolator())
                        .start();
            }
        }
        updateVoiceHeaderState();
        scrollVoiceTranscriptToBottom();
    }

    private void attachSwipeDismiss(final View row, final MoaVoiceTranscriptLog.Entry entry) {
        final int touchSlop = android.view.ViewConfiguration.get(this).getScaledTouchSlop();
        final long longPressMs = android.view.ViewConfiguration.getLongPressTimeout();
        View.OnTouchListener listener = new View.OnTouchListener() {
            private float downX;
            private float downY;
            private boolean decided;
            private boolean swiping;
            private long downTime;

            @Override
            public boolean onTouch(View v, android.view.MotionEvent event) {
                switch (event.getActionMasked()) {
                    case android.view.MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        decided = false;
                        swiping = false;
                        downTime = event.getEventTime();
                        return v == row;
                    case android.view.MotionEvent.ACTION_MOVE: {
                        float dx = event.getRawX() - downX;
                        float dy = event.getRawY() - downY;
                        if (!decided) {
                            MoaTranscriptSwipePolicy.Decision decision = MoaTranscriptSwipePolicy.decide(
                                    dx, dy, touchSlop, event.getEventTime() - downTime,
                                    longPressMs, transcriptSelectionActive);
                            if (decision == MoaTranscriptSwipePolicy.Decision.SWIPE) {
                                decided = true;
                                swiping = true;
                                android.view.ViewParent parent = row.getParent();
                                if (parent != null) {
                                    parent.requestDisallowInterceptTouchEvent(true);
                                }
                            } else if (decision == MoaTranscriptSwipePolicy.Decision.RELEASE) {
                                decided = true;
                                swiping = false;
                            }
                        }
                        if (swiping) {
                            row.setTranslationX(dx);
                            float frac = Math.min(1f, Math.abs(dx) / Math.max(1, row.getWidth()));
                            row.setAlpha(1f - 0.72f * frac);
                            return true;
                        }
                        return v == row;
                    }
                    case android.view.MotionEvent.ACTION_UP:
                    case android.view.MotionEvent.ACTION_CANCEL: {
                        if (!swiping) {
                            return false;
                        }
                        float dx = event.getRawX() - downX;
                        float width = Math.max(1, row.getWidth());
                        boolean dismiss = MoaTranscriptSwipePolicy.shouldDismiss(dx, width, dp(120));
                        if (dismiss && event.getActionMasked() == android.view.MotionEvent.ACTION_UP) {
                            animateSwipeOutThenCascade(row, entry, dx >= 0);
                        } else {
                            row.animate().translationX(0f).alpha(1f).setDuration(150).start();
                        }
                        return true;
                    }
                    default:
                        return false;
                }
            }
        };
        row.setOnTouchListener(listener);
        View selectable = findSelectableText(row);
        if (selectable != null) selectable.setOnTouchListener(listener);
    }

    private View findSelectableText(View view) {
        if (view instanceof TextView && ((TextView) view).isTextSelectable()) return view;
        if (!(view instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) view;
        for (int i = 0; i < group.getChildCount(); i++) {
            View found = findSelectableText(group.getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }

    private void animateSwipeOutThenCascade(final View row, final MoaVoiceTranscriptLog.Entry entry, boolean toRight) {
        int dir = toRight ? 1 : -1;
        float target = dir * Math.max(row.getWidth(), dp(320));
        row.animate()
                .translationX(target)
                .alpha(0f)
                .setDuration(160)
                .setInterpolator(new android.view.animation.AccelerateInterpolator())
                .withEndAction(() -> dismissCascadeFromEntry(entry))
                .start();
    }

    private void dismissCascadeFromEntry(MoaVoiceTranscriptLog.Entry entry) {
        voiceLog.dismissCascadeFrom(entry);
        voiceUserTranscript = voiceLog.currentUserText();
        voiceAssistantTranscript = voiceLog.currentAssistantText();
        if (voiceLog.isEmpty()) {
            removeTranscriptOverlay();
        } else {
            renderVoiceTranscriptRows();
        }
    }

    private View voiceMessageRow(boolean assistant, String text, boolean finalText) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);

        TextView label = text(assistant ? "A.G." : "You", assistant ? MoaColors.GOLD : 0xFFBFA9FF, 10, true);
        label.setLetterSpacing(0.08f);
        label.setPadding(dp(5), 0, dp(5), dp(3));

        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(14), dp(11), dp(14), dp(11));
        int r = dp(19);
        int tuck = dp(6);
        float[] radii = assistant
                ? new float[]{r, r, r, r, r, r, tuck, tuck}
                : new float[]{r, r, r, r, tuck, tuck, r, r};
        int fill = assistant ? MoaColors.RAISED : MoaColors.USER_BG;
        int stroke = assistant ? MoaColors.RAISED_BORDER : MoaColors.USER_BORDER;
        bubble.setBackground(MoaDrawables.roundedCorners(fill, radii, stroke, dp(1)));

        String bodyText = text.isEmpty() ? "..." : text;
        TextView body = text(bodyText, MoaColors.PAPER, assistant ? 15 : 16, false);
        body.setTextIsSelectable(true);
        body.setCustomSelectionActionModeCallback(new ActionMode.Callback() {
            @Override public boolean onCreateActionMode(ActionMode mode, android.view.Menu menu) {
                transcriptSelectionActive = true;
                return true;
            }
            @Override public boolean onPrepareActionMode(ActionMode mode, android.view.Menu menu) { return false; }
            @Override public boolean onActionItemClicked(ActionMode mode, android.view.MenuItem item) { return false; }
            @Override public void onDestroyActionMode(ActionMode mode) { transcriptSelectionActive = false; }
        });
        body.setLineSpacing(dp(4), 1f);
        body.setMaxWidth(Math.min(getResources().getDisplayMetrics().widthPixels - dp(92), dp(430)));
        body.setAlpha(text.isEmpty() ? 0.48f : finalText ? 1f : 0.82f);
        bubble.addView(body);

        wrap.addView(label);
        wrap.addView(bubble);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.gravity = assistant ? Gravity.START : Gravity.END;
        params.topMargin = dp(assistant ? 11 : 5);
        params.leftMargin = assistant ? 0 : dp(34);
        params.rightMargin = assistant ? dp(34) : 0;
        wrap.setLayoutParams(params);
        wrap.setGravity(assistant ? Gravity.START : Gravity.END);
        return wrap;
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

    private void updateVoiceHeaderState() {
        String runStatus = agentRunStatusText();
        if (voiceMetaLine != null) {
            String status = "Ready".equals(runStatus)
                    ? voiceStateWord() + " · " + MoaPrefs.companionName(this)
                    : runStatus + " · " + voiceStateWord();
            voiceMetaLine.setText(status);
            voiceMetaLine.setTextColor(voiceStateColor());
        }
        if (voiceLanguageLine != null) {
            voiceLanguageLine.setText(sessionLanguageStatus());
        }
    }

    private String sessionLanguageStatus() {
        String hear = sessionHearLanguages.isEmpty()
                ? MoaPrefs.inputLanguagesShort(this)
                : sessionHearLanguages;
        String speak = sessionSpeakLanguage.isEmpty()
                ? MoaPrefs.shortLanguageTag(MoaPrefs.replyLanguageTag(this))
                : sessionSpeakLanguage;
        if (hear.isEmpty()) {
            hear = "?";
        }
        if (speak.isEmpty()) {
            speak = "?";
        }
        return "Hears " + hear + " / Speaks " + speak;
    }

    private String voiceStateWord() {
        switch (voiceRuntimeState) {
            case LISTENING:
                return "Listening";
            case SENDING:
                return "Sending";
            case THINKING:
                return "Thinking";
            case SPEAKING:
                return "Speaking";
            case ERROR:
                return "Error";
            case INTERRUPTED:
                return "Interrupted";
            case RECOVERING:
                return "Recovering";
            default:
                return "Ready";
        }
    }

    private int voiceStateColor() {
        switch (voiceRuntimeState) {
            case ERROR:
                return MoaColors.EMBER;
            case INTERRUPTED:
            case RECOVERING:
                return MoaColors.GOLD;
            case SENDING:
            case THINKING:
            case SPEAKING:
                return MoaColors.GOLD;
            default:
                return MoaColors.MUTED;
        }
    }

    private void scrollVoiceTranscriptToBottom() {
        if (voiceTranscriptScroll == null) {
            return;
        }
        mainHandler.postDelayed(() -> {
            if (voiceTranscriptScroll != null) {
                voiceTranscriptScroll.fullScroll(View.FOCUS_DOWN);
            }
        }, 30);
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
        if (transcriptView == null) {
            return;
        }
        final View dying = transcriptView;
        transcriptView = null;
        transcriptParams = null;
        voiceTranscriptColumn = null;
        voiceTranscriptScroll = null;
        voiceMetaLine = null;
        voiceLanguageLine = null;
        transcriptSelectionActive = false;
        dying.animate()
                .alpha(0f)
                .translationY(dp(12))
                .setDuration(140)
                .setInterpolator(new android.view.animation.AccelerateInterpolator())
                .withEndAction(() -> MoaOverlayWindowLayout.detach(windowManager, dying))
                .start();
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

    private void scheduleContinuousVoiceRestart(int generation) {
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

    private void cancelContinuousVoiceRestart() {
        if (pendingContinuousVoiceRestart != null) {
            mainHandler.removeCallbacks(pendingContinuousVoiceRestart);
            pendingContinuousVoiceRestart = null;
        }
        pendingContinuousVoiceRestartAfterAudio = false;
    }

    private View createPanel() {
        FrameLayout shell = new FrameLayout(this);
        shell.setBackground(MoaDrawables.roundedGradient(MoaColors.RAISED, MoaColors.PANEL_BG, dp(26), MoaColors.PANEL_BORDER, dp(1)));
        shell.setElevation(dp(28));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            shell.setOutlineSpotShadowColor(0xFF000000);
            shell.setOutlineAmbientShadowColor(0xFF000000);
        }
        shell.setClipToOutline(true);
        shell.setOutlineProvider(new android.view.ViewOutlineProvider() {
            @Override
            public void getOutline(View view, android.graphics.Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), dp(26));
            }
        });

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(16), dp(15), dp(16), dp(15));
        shell.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        panel.addView(createHeader());
        panel.addView(createContextControlsRow());

        messageScroll = new ScrollView(this);
        messageScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        messageScroll.setVerticalScrollBarEnabled(false);
        messageScroll.setClipToPadding(false);
        messageScroll.setPadding(0, dp(2), 0, dp(2));
        messageColumn = new LinearLayout(this);
        messageColumn.setOrientation(LinearLayout.VERTICAL);
        messageScroll.addView(messageColumn, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(260)
        );
        scrollParams.topMargin = dp(10);
        panel.addView(messageScroll, scrollParams);

        panel.addView(createComposer());
        return shell;
    }

    private View createHeader() {
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setPadding(0, 0, 0, dp(4));

        PulseDot dot = new PulseDot(this);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(10), dp(10));
        dotParams.rightMargin = dp(10);
        dotParams.gravity = Gravity.CENTER_VERTICAL;
        header.addView(dot, dotParams);

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);

        TextView label = text("A.G.", MoaColors.PAPER, 17, true);
        label.setLetterSpacing(0.02f);
        copy.addView(label);
        runStatusView = text(overlayHeaderStatusText(), MoaColors.MUTED, 11, false);
        copy.addView(runStatusView);
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        recordModePill = pill("Record", 0x16FFFFFF, MoaColors.MUTED);
        recordModePill.setOnClickListener(v -> toggleRecordMode());
        refreshRecordModePill();
        header.addView(recordModePill);

        TextView hide = pill("Hide", 0x16FF453A, 0xFFFFAAA4);
        hide.setContentDescription("Hide the A.G. orb");
        hide.setOnClickListener(v -> stopSelf());
        header.addView(hide);

        TextView close = pill("×", 0x16FFFFFF, MoaColors.MUTED);
        close.setContentDescription("Close chat");
        close.setOnClickListener(v -> dismissOverlayUi());
        header.addView(close);
        attachSurfaceHeaderDrag(header);
        return header;
    }

    private View createContextControlsRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(6), dp(5), dp(6), dp(5));
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rowParams.topMargin = dp(8);
        row.setLayoutParams(rowParams);
        contextControlsRow = row;

        newThreadPill = pill("New thread", 0x16FFFFFF, MoaColors.MUTED);
        newThreadPill.setOnClickListener(v -> toggleNewThreadArmed());
        row.addView(newThreadPill);

        incognitoPill = pill("Incognito", 0x16FFFFFF, MoaColors.MUTED);
        incognitoPill.setOnClickListener(v -> toggleIncognito());
        row.addView(incognitoPill);

        // Flexible spacer keeps the pills left-aligned; the row tint fills behind.
        row.addView(new View(this), new LinearLayout.LayoutParams(0, dp(1), 1f));

        refreshContextControls();
        return row;
    }

    private void toggleNewThreadArmed() {
        contextControls.toggleNewThread();
        refreshContextControls();
    }

    private void toggleIncognito() {
        contextControls.toggleIncognito();
        refreshContextControls();
    }

    private void refreshContextControls() {
        if (newThreadPill != null) {
            boolean armed = contextControls.isNewThreadArmed();
            newThreadPill.setText(armed ? "New thread armed" : "New thread");
            newThreadPill.setTextColor(armed ? MoaColors.INK : MoaColors.MUTED);
            newThreadPill.setBackground(MoaDrawables.rounded(
                    armed ? MoaColors.GOLD : 0x16FFFFFF,
                    dp(999),
                    armed ? 0x33FFFFFF : 0x10FFFFFF,
                    dp(1)
            ));
        }
        if (incognitoPill != null) {
            boolean on = contextControls.isIncognitoEnabled();
            incognitoPill.setText(on ? "Incognito on" : "Incognito");
            incognitoPill.setTextColor(on ? MoaColors.INK : MoaColors.MUTED);
            incognitoPill.setBackground(MoaDrawables.rounded(
                    on ? MoaColors.EMBER : 0x16FFFFFF,
                    dp(999),
                    on ? 0x40FFFFFF : 0x10FFFFFF,
                    dp(1)
            ));
        }
        if (contextControlsRow != null) {
            // Persistent tinted status row while incognito is on.
            contextControlsRow.setBackground(contextControls.isIncognitoEnabled()
                    ? MoaDrawables.rounded(0x22FF8A3D, dp(14), 0x40FF8A3D, dp(1))
                    : null);
        }
    }

    private View createComposer() {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(6), dp(6), dp(6), dp(6));
        row.setBackground(MoaDrawables.rounded(MoaColors.COMPOSER_BG, dp(26), MoaColors.COMPOSER_BORDER, dp(1)));

        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rowParams.topMargin = dp(12);
        row.setLayoutParams(rowParams);

        composer = new EditText(this);
        composer.setHint("Message A.G.");
        composer.setHintTextColor(MoaColors.MUTED);
        composer.setTextColor(MoaColors.PAPER);
        composer.setTextSize(15);
        composer.setMinLines(1);
        composer.setMaxLines(4);
        composer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setSingleLine(false);
        composer.setBackgroundColor(Color.TRANSPARENT);
        composer.setPadding(dp(12), dp(9), dp(8), dp(9));
        row.addView(composer, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        // Round gold send button. 46dp target, gold brand accent.
        TextView send = new TextView(this);
        send.setText("↑");
        send.setTextColor(MoaColors.INK);
        send.setTextSize(20);
        send.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        send.setGravity(Gravity.CENTER);
        send.setBackground(MoaDrawables.circle(MoaColors.GOLD, 0x33FFFFFF, dp(1)));
        LinearLayout.LayoutParams sendParams = new LinearLayout.LayoutParams(dp(46), dp(46));
        sendParams.leftMargin = dp(4);
        send.setLayoutParams(sendParams);
        send.setOnClickListener(v -> sendComposer(false));
        row.addView(send);
        return row;
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

    private void renderMessages() {
        if (messageColumn == null) {
            return;
        }

        messageColumn.removeAllViews();
        if (messages.isEmpty()) {
            TextView empty = text(orbGestureHint(), MoaColors.MUTED, 13, false);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(8), dp(28), dp(8), dp(28));
            messageColumn.addView(empty);
            return;
        }
        for (ChatMessage message : messages) {
            messageColumn.addView(messageBubble(message));
        }
        if (messageScroll != null) {
            mainHandler.postDelayed(() -> {
                if (messageScroll != null) {
                    messageScroll.fullScroll(View.FOCUS_DOWN);
                }
            }, 40);
        }
    }

    private View messageBubble(ChatMessage message) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);

        TextView label = text(message.assistant ? "A.G." : "You", message.assistant ? MoaColors.GOLD : 0xFFBFA9FF, 10, true);
        label.setLetterSpacing(0.08f);
        label.setPadding(dp(4), 0, dp(4), dp(3));

        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(14), dp(11), dp(14), dp(11));
        int r = dp(20);
        int tuck = dp(6);
        float[] radii = message.assistant
                // tl, tr, br, bl  -> tuck bottom-left
                ? new float[]{r, r, r, r, r, r, tuck, tuck}
                // tuck bottom-right
                : new float[]{r, r, r, r, tuck, tuck, r, r};
        int fill = message.assistant ? MoaColors.RAISED : MoaColors.USER_BG;
        int stroke = message.assistant ? MoaColors.RAISED_BORDER : MoaColors.USER_BORDER;
        bubble.setBackground(MoaDrawables.roundedCorners(fill, radii, stroke, dp(1)));

        // Cap the text width so a bubble never spans edge to edge (~80%).
        int maxBubbleText = (int) (getResources().getDisplayMetrics().widthPixels * 0.80f) - dp(28) - dp(36);
        TextView body = text(message.text, MoaColors.PAPER, 15, false);
        body.setLineSpacing(dp(4), 1f);
        body.setMaxWidth(maxBubbleText);
        bubble.addView(body);

        wrap.addView(label);
        wrap.addView(bubble);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.gravity = message.assistant ? Gravity.START : Gravity.END;
        params.topMargin = dp(9);
        params.leftMargin = message.assistant ? 0 : dp(36);
        params.rightMargin = message.assistant ? dp(36) : 0;
        wrap.setLayoutParams(params);
        wrap.setGravity(message.assistant ? Gravity.START : Gravity.END);
        return wrap;
    }

    private void sendComposer(boolean fromVoice) {
        if (composer == null) {
            return;
        }
        String text = composer.getText().toString().trim();
        if (text.isEmpty()) {
            return;
        }
        composer.setText("");
        sendUserMessage(text, fromVoice);
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
        boolean manualVoiceFollowUp = fromVoice && nextManualVoiceFollowsActiveRun;
        nextManualVoiceFollowsActiveRun = false;

        MoaActionBroker.LocalActionResult localAction = actionBroker.tryHandleLocalCommand(text);
        if (localAction.handled) {
            deliverReply(localAction.reply, fromVoice);
            return;
        }

        if (manualVoiceFollowUp) {
            requestAgentRunFollowUp(text, true);
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
            deliverReply("The gateway isn't connected yet. Open the Moa app to set it up.", fromVoice);
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
            if (forcedAgent) {
                requestAgentRun(spokenAgentPrompt(userText), fromVoice);
            } else {
                requestGatewayReply(userText, fromVoice);
            }
            return;
        }

        new Thread(() -> {
            try {
                JSONObject response = gatewayClient().voiceTurn(requestBody);
                mainHandler.post(() -> deliverVoiceTurnReply(response, userText, fromVoice, forcedAgent));
            } catch (Exception error) {
                mainHandler.post(() -> {
                    if (forcedAgent) {
                        requestAgentRun(spokenAgentPrompt(userText), fromVoice);
                    } else {
                        requestGatewayReply(userText, fromVoice);
                    }
                });
            }
        }, "moa-voice-turn").start();
    }

    private JSONObject voiceTurnRequestBody(String userText, boolean fromVoice, boolean forcedAgent) throws JSONException {
        JSONObject body = gatewayRequestBody();
        body.put("session_id", conversationId);
        body.put("branch_id", "default");
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
        String display = response.optString("display", "").trim();
        String speakText = response.optString("speak", "").trim();
        String text = display.isEmpty() ? response.optString("text", speakText).trim() : display;
        if (text.isEmpty()) {
            // The gateway answered with no display, speak, or text. On the voice
            // path the overlay was left in THINKING forever; reset it to READY
            // with a visible notice instead of a silent hang.
            if (fromVoice) {
                String notice = "I didn't get a reply. Tap to try again.";
                updateVoiceAssistantTranscript(notice);
                setVoiceRuntimeState(VoiceRuntimeState.READY);
                updateMicState();
                holdVoiceReplyThenContinueOrDismiss();
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
            deliverReply("Agent actions need the A.G. gateway. Set the home-machine URL first.", fromVoice);
            return;
        }

        JSONObject requestBody;
        try {
            JSONObject body = new JSONObject();
            body.put("conversation_id", conversationId);
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

    private void requestAgentRunFollowUp(String text, boolean fromVoice) {
        String parentRunId = activeFollowUpRunId();
        if (parentRunId.isEmpty()) {
            requestVoiceTurn(text, fromVoice, true);
            return;
        }

        JSONObject requestBody;
        try {
            JSONObject body = new JSONObject();
            body.put("conversation_id", conversationId);
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
        JSONObject body = new JSONObject();
        body.put("conversation_id", conversationId);
        body.put("source", "android-overlay");
        body.put("device_id", androidDeviceId());
        actionBroker.putScreenContext(body);

        JSONArray history = new JSONArray();
        int start = Math.max(0, messages.size() - MAX_GATEWAY_MESSAGES);
        for (int i = start; i < messages.size(); i++) {
            ChatMessage message = messages.get(i);
            JSONObject item = new JSONObject();
            item.put("role", message.assistant ? "assistant" : "user");
            item.put("content", message.text);
            history.put(item);
        }
        body.put("messages", history);
        applyContextControls(body);
        return body;
    }

    // Attach the explicit client thread control to an HTTP turn body (chat or
    // voice turn). Incognito is a persistent mode and always wins; the one-shot
    // new-thread arm is consumed by the turn it rides on. The gateway treats an
    // explicit context_action as an override that beats the model's own choice.
    private void applyContextControls(JSONObject body) throws JSONException {
        if (contextControls.applyTo(body)) {
            refreshContextControls();
        }
    }

    private String androidDeviceId() {
        String raw = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        String safe = raw == null ? "" : raw.replaceAll("[^a-zA-Z0-9_-]", "");
        if (safe.isEmpty()) {
            safe = "unknown";
        }
        return "android_" + safe;
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
        ToolRequestExecution execution;
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
            execution = new ToolRequestExecution(result.success, result.reply, result.receipt);
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
                new ToolRequestExecution(result.success, result.reply, result.receipt));
    }
    private void finishClaimedToolRequest(String requestId, ToolRequestExecution execution) {
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
        if (dialog.getWindow() != null) dialog.getWindow().setType(overlayType());
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
                        new ToolRequestExecution(completed.success, completed.reply, completed.receipt))));
        if (result.pending) return;
        finishClaimedToolRequest(requestId,
                new ToolRequestExecution(result.success, result.reply, result.receipt));
    }

    private ToolRequestExecution executeAudioSpeakRequest(JSONObject input) {
        String text = safe(input.optString("text", input.optString("message", input.optString("utterance", ""))));
        if (text.isEmpty()) {
            JSONObject receipt = MoaActionReceiptStore.record(this, "audio.speak", "local_output", "implicit_user_command", "", false, "Speech text is required.");
            return new ToolRequestExecution(false, "Speech text is required.", receipt);
        }
        boolean spoken = voiceController != null && voiceController.speak(text);
        String summary = spoken
                ? "Spoke requested text."
                : "On-device speech is disabled by policy; replies speak through hosted audio only.";
        JSONObject receipt = MoaActionReceiptStore.record(
                this, "audio.speak", "local_output", "implicit_user_command",
                "device_speaker", spoken, summary);
        return new ToolRequestExecution(spoken, summary, receipt);
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
        if (runStatusView != null) {
            runStatusView.setText(overlayHeaderStatusText());
        }
        updateVoiceHeaderState();
    }

    private String overlayHeaderStatusText() {
        String runStatus = agentRunStatusText();
        return "Ready".equals(runStatus) ? MoaPrefs.companionCompactStatus(this) : runStatus;
    }

    private String activeFollowUpRunId() {
        return agentRuns.activeFollowUpRunId();
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
    }

    private String agentPromptFrom(String text) {
        return MoaOperationalTurnRouter.agentPromptFrom(text);
    }

    private boolean shouldRunAgentFromVoice(String text, boolean fromVoice) {
        return MoaOperationalTurnRouter.shouldRunAgentFromVoice(text, fromVoice);
    }

    private String spokenAgentPrompt(String text) {
        return "The user spoke this from the A.G. Android overlay and expects forward progress, not a chat-only answer.\n\n"
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
        return audioNoteActive || reviewableVoiceDraftActive();
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
        if (audioNoteActive) {
            cancelAudioNoteCapture();
        }
        if (pushToTalkVoiceTurn || streamingVoiceActive()) {
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
        if (streamingVoiceActive() || voiceController.isActive() || voiceSamplePlayer != null || continuousVoiceLoop || pendingContinuousVoiceRestart != null) {
            dismissOverlayUi(false);
        }
        loadSettings();
        pushToTalkVoiceTurn = true;
        if (streamingVoiceAvailable()) {
            continuousVoiceLoop = false;
            cancelContinuousVoiceRestart();
            cancelVoiceSampler();
            if (orbView != null) {
                orbView.setHeld(true);
            }
            nextStreamingTurnFollowsActiveRun = agentRuns.hasRuns();
            nextManualVoiceFollowsActiveRun = false;
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
        if (!pushToTalkVoiceTurn) {
            return;
        }
        pushToTalkVoiceTurn = false;
        if (orbView != null) {
            orbView.setHeld(false);
        }
        // Released while an incognito / new-thread branch switch is still in
        // flight: the session has not opened yet, so remember to commit as soon
        // as it does instead of dropping the release.
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
            updateVoiceAssistantTranscript(failure);
            speakOverlayNotice(failure);
            setVoiceRuntimeState(VoiceRuntimeState.ERROR);
            updateMicState();
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
        if (nextStreamingTurnFollowsActiveRun || agentRuns.hasRuns()) {
            currentStreamingTurnRouted = true;
            currentStreamingTurnCommitRequested = false;
            nextStreamingTurnFollowsActiveRun = false;
            addMessage(false, value);
            updateVoiceUserTranscript(value, true);
            setVoiceRuntimeState(VoiceRuntimeState.THINKING);
            requestAgentRunFollowUp(value, true);
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
        cancelAudioNoteCapture();
        discardWarmMic();
        pushToTalkVoiceTurn = false;
        continuousVoiceLoop = false;
        suppressFirstTapTurnEmptyCue = false;
        nextManualVoiceFollowsActiveRun = false;
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

    private void refreshRecordModePill() {
        if (recordModePill == null) {
            return;
        }
        boolean on = recordModeEnabled;
        recordModePill.setText(on ? "Record on" : "Record");
        recordModePill.setTextColor(on ? MoaColors.INK : MoaColors.MUTED);
        recordModePill.setBackground(MoaDrawables.rounded(
                on ? MoaColors.GOLD : 0x16FFFFFF,
                dp(999),
                on ? 0x33FFFFFF : 0x10FFFFFF,
                dp(1)
        ));
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
        continuousVoiceLoop = reviewableDraft;
        cancelContinuousVoiceRestart();
        if (streamingVoiceActive()) {
            cancelStreamingVoice();
        }
        cancelVoiceSampler();
        if (orbView != null) {
            orbView.setHeld(true);
        }
        nextManualVoiceFollowsActiveRun = agentRuns.hasRuns();
        nextStreamingTurnFollowsActiveRun = agentRuns.hasRuns();
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
        continuousVoiceLoop = false;
        suppressFirstTapTurnEmptyCue = false;
        invalidatePendingBranchSwitch();
        cancelContinuousVoiceRestart();
        cancelStreamingTurnWatchdog();
        if (streamingVoiceActive()) {
            streamingVoiceController.cancel();
            streamingVoiceController = null;
            nextStreamingTurnFollowsActiveRun = false;
        }
        // Deliberately does NOT call voiceController.stopQuietly(): on the
        // streaming path the local recognizer is idle, and stopQuietly would
        // fire onRemoveTranscript and tear the card down.
    }

    private void cancelStreamingVoice() {
        pushToTalkVoiceTurn = false;
        continuousVoiceLoop = false;
        suppressFirstTapTurnEmptyCue = false;
        invalidatePendingBranchSwitch();
        cancelContinuousVoiceRestart();
        cancelStreamingTurnWatchdog();
        if (streamingVoiceActive()) {
            streamingVoiceController.cancel();
            streamingVoiceController = null;
            nextStreamingTurnFollowsActiveRun = false;
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

    private void setComposerText(String text) {
        if (composer == null) {
            return;
        }
        composer.setText(text);
        composer.setSelection(composer.getText().length());
    }

    private void startStreamingVoiceTurn(boolean autoCommitOnSilence) {
        startStreamingVoiceTurn(autoCommitOnSilence, false);
    }

    private void startContinuousStreamingVoiceTurn() {
        if (!streamingVoiceAvailable()) {
            startLocalVoiceTurn(false, false);
            return;
        }
        startStreamingVoiceTurn(true, true);
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
            openStreamingVoiceSession(autoCommitOnSilence, continuousLoop, "default", false);
            return;
        }
        resolveThreadBranchThenOpenStreamingVoice(autoCommitOnSilence, continuousLoop, choice.action);
    }

    // Resolve the thread branch for an incognito / new-thread streaming voice turn
    // off the main thread, then open the session on the returned branch. The fast
    // (default-branch) path never enters here, so ordinary voice keeps its
    // immediate socket connect. An incognito switch that fails is surfaced rather
    // than silently opening a persisted session, keeping the incognito guarantee.
    private void resolveThreadBranchThenOpenStreamingVoice(boolean autoCommit, boolean continuous, String action) {
        final boolean incognito = "incognito".equals(action);
        // Release any prior controller/timers so the mic and socket are free while
        // the branch resolves, mirroring openStreamingVoiceSession's entry.
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
                    // Superseded by a newer start, cancel, or dismiss.
                    return;
                }
                streamingBranchSwitchPending = false;
                boolean switchOk = !resolvedBranch.isEmpty();
                if (incognito && !switchOk) {
                    // Never open a persisted session for an incognito request; that
                    // would break the "nothing is stored" guarantee.
                    streamingCommitPendingOpen = false;
                    pushToTalkVoiceTurn = false;
                    if (orbView != null) {
                        orbView.setHeld(false);
                    }
                    String notice = "Couldn't start a private turn. Try again.";
                    showTranscriptOverlay("");
                    updateVoiceAssistantTranscript(notice);
                    setVoiceRuntimeState(VoiceRuntimeState.ERROR);
                    updateMicState();
                    return;
                }
                String branchToUse = switchOk ? resolvedBranch : "default";
                openStreamingVoiceSession(autoCommit, continuous, branchToUse, incognito && switchOk);
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
        continuousVoiceLoop = continuousLoop;
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
                showTranscriptOverlay("");
                setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
                updateMicState();
            }

            @Override
            public void onSessionReady(String sessionId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                // If the user already released (commit deferred until now), the
                // turn is in flight: promote to THINKING and drop the watchdog's
                // "sending" state instead of falling back to LISTENING.
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
            public void onRecordingStopped() {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                currentStreamingTurnCommitRequested = true;
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
                    if (nextStreamingTurnFollowsActiveRun || agentRuns.hasRuns()) {
                        currentStreamingTurnRouted = true;
                        nextStreamingTurnFollowsActiveRun = false;
                        addMessage(false, transcript);
                        updateVoiceUserTranscript(transcript, true);
                        requestAgentRunFollowUp(transcript, true);
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
                currentStreamingTurnAudioReceived = true;
                if (currentStreamingTurnRouted) {
                    return;
                }
                streamingAssistantAudioPlaying = true;
                setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
                updateMicState();
            }

            @Override
            public void onAssistantAudioChunk(String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                // Keep the watchdog pushed out while audio keeps flowing; the gap
                // between frames is ~40ms, so 30s of silence is a genuine stall.
                // Guarded on active playback so a stray late frame never re-arms a
                // watchdog after the turn has already finished.
                if (streamingAssistantAudioPlaying) {
                    resetStreamingTurnWatchdog();
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
                setVoiceRuntimeState(VoiceRuntimeState.READY);
                if (pendingContinuousVoiceRestartAfterAudio) {
                    pendingContinuousVoiceRestartAfterAudio = false;
                    showReadyForNextVoiceTurn(generation);
                }
            }

            @Override
            public void onTurnDone(String turnId, String status, boolean transcriptionOnly, boolean ttsSpoke, String replyLanguage) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                cancelStreamingTurnWatchdog();
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
                    nextStreamingTurnFollowsActiveRun = false;
                    recordCurrentStreamingAssistant();
                    if (streamingTurnIncognito) {
                        markCurrentReplyNotSaved();
                    }
                }
                String turnStatus = safe(status);
                if ("completed".equals(turnStatus)) {
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
                    updateVoiceAssistantTranscript(notice);
                    speakOverlayNotice(notice);
                    setVoiceRuntimeState(VoiceRuntimeState.READY);
                } else if ("error".equals(turnStatus)) {
                    String notice = "The voice turn failed. Tap to try again.";
                    updateVoiceAssistantTranscript(notice);
                    speakOverlayNotice(notice);
                    setVoiceRuntimeState(VoiceRuntimeState.ERROR);
                    continuousVoiceLoop = false;
                }
                updateMicState();
                mainHandler.postDelayed(() -> {
                    if (isCurrentStreamingGeneration(generation)) {
                        showReadyForNextVoiceTurn(generation);
                    }
                }, 700);
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
                    String notice = "Voice connection dropped — try again.";
                    updateVoiceAssistantTranscript(notice);
                    speakOverlayNotice(notice);
                    setVoiceRuntimeState(VoiceRuntimeState.ERROR);
                    continuousVoiceLoop = false;
                    updateMicState();
                    mainHandler.postDelayed(() -> {
                        if (isCurrentStreamingGeneration(generation)) {
                            showReadyForNextVoiceTurn(generation);
                        }
                    }, 900);
                    return;
                }
                if (continuousVoiceLoop && currentStreamingTranscript.isEmpty() && voiceAssistantTranscript.isEmpty()) {
                    continuousVoiceLoop = false;
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
                cancelStreamingTurnWatchdog();
                nextStreamingTurnFollowsActiveRun = false;
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
                updateVoiceAssistantTranscript(notice);
                speakOverlayNotice("The voice turn failed. Tap to try again.");
                setVoiceRuntimeState(VoiceRuntimeState.ERROR);
                continuousVoiceLoop = false;
                mainHandler.postDelayed(() -> {
                    if (isCurrentStreamingGeneration(generation)) {
                        showReadyForNextVoiceTurn(generation);
                    }
                }, 900);
            }
        });
        if (!pendingReplacementTurnId.isEmpty()) {
            streamingVoiceController.setTurnIdentity(pendingReplacementTurnId, androidDeviceId());
            pendingReplacementTurnId = "";
        } else {
            streamingVoiceController.setTurnIdentity("", androidDeviceId());
        }
        // Hand over the gesture-warmed mic (or the mic pre-warmed during the
        // continuous re-arm gap) so the session goes live instantly and, for
        // push-to-talk, drains the pre-roll. Null here means a cold start.
        streamingVoiceController.setPrewarmedCapture(adoptWarmMic());
        streamingVoiceController.startSession();
        if (streamingCommitPendingOpen) {
            // The user released while the branch was still resolving. Commit the
            // turn now that the session exists so it does not hang listening; a
            // near-empty capture returns a no_speech turn_done rather than a stall.
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
            return "Voice can't connect: the gateway rejected this device's token. Re-pair in the Moa app.";
        }
        if (normalized.contains("url issue")
                || normalized.contains("not deployed")
                || normalized.contains("could not resolve")) {
            return "Voice can't connect. Check the gateway URL in the Moa app.";
        }
        return "The voice turn failed. Tap to try again.";
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
        animateNextAssistantRow = false;
        currentStreamingAssistantRecorded = false;
        renderVoiceTranscriptRows();
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
        nextStreamingTurnFollowsActiveRun = false;
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
        updateVoiceAssistantTranscript(text + NOT_SPOKEN_SUFFIX);
    }

    private void markCurrentReplyNotSaved() {
        String marked = MoaContextControlState.appendNotSaved(voiceAssistantTranscript);
        if (!marked.equals(safe(voiceAssistantTranscript))) {
            updateVoiceAssistantTranscript(marked);
        }
    }

    private boolean shouldStartVoice(Intent intent) {
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
        TextView pill = text(text, foreground, 11, true);
        pill.setGravity(Gravity.CENTER);
        pill.setPadding(dp(10), dp(5), dp(10), dp(5));
        pill.setBackground(MoaDrawables.rounded(background, dp(999), 0x10FFFFFF, dp(1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.rightMargin = dp(6);
        pill.setLayoutParams(params);
        return pill;
    }

    private TextView text(String text, int color, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(color);
        view.setTextSize(sp);
        if (bold) {
            view.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        }
        return view;
    }

    private int overlayType() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        }
        return WindowManager.LayoutParams.TYPE_PHONE;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private String cleanError(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            message = error.getClass().getSimpleName();
        }
        message = message.replace('\n', ' ').replace('\r', ' ').trim();
        if (message.length() > 180) {
            return message.substring(0, 180);
        }
        return message;
    }

    private static final class CappedScrollView extends ScrollView {
        private final int maxHeight;

        CappedScrollView(android.content.Context context, int maxHeight) {
            super(context);
            this.maxHeight = maxHeight;
        }

        @Override
        protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            int parentMode = View.MeasureSpec.getMode(heightMeasureSpec);
            int parentSize = View.MeasureSpec.getSize(heightMeasureSpec);
            int cap = parentMode == View.MeasureSpec.UNSPECIFIED || parentSize <= 0
                    ? maxHeight
                    : Math.min(parentSize, maxHeight);
            int cappedHeight = View.MeasureSpec.makeMeasureSpec(cap, View.MeasureSpec.AT_MOST);
            super.onMeasure(widthMeasureSpec, cappedHeight);
        }
    }

    private static final class ToolRequestExecution {
        final boolean success;
        final String summary;
        final JSONObject receipt;

        ToolRequestExecution(boolean success, String summary, JSONObject receipt) {
            this.success = success;
            this.summary = summary == null ? "" : summary.trim();
            this.receipt = receipt;
        }
    }

}

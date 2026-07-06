package ai.moa.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
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
    static final String EXTRA_START_VOICE = "ai.moa.assistant.extra.START_VOICE";

    private static final int MAX_HISTORY_MESSAGES = 50;
    private static final int MAX_GATEWAY_MESSAGES = 24;
    private static final int MAX_AGENT_PROMPT_CHARS = 12000;
    private static final int ORB_WINDOW_DP = 96;
    private static final int ORB_EDGE_MARGIN_DP = 16;
    private static final int OVERLAY_NOTIFICATION_ID = 5701;
    private static final long VOICE_USER_EXIT_MS = 150;
    private static final long VOICE_RESPONSE_HOLD_MS = 1200;
    // A text-only reply (the gateway returned text but no spoken audio) is held on
    // screen noticeably longer than a spoken one, since the eye is the only way to
    // receive it. Paired with a small "(not spoken)" marker so it does not read as
    // a broken or blank turn. No local TTS is used (hosted-audio-only policy).
    private static final long VOICE_NOT_SPOKEN_HOLD_MS = 5000;
    private static final String NOT_SPOKEN_SUFFIX = "\n\n(not spoken)";
    // Mirror of the "(not spoken)" convention for an incognito turn the gateway
    // answered but did not persist (context.persisted === false).
    private static final String NOT_SAVED_SUFFIX = "\n\n(not saved)";
    // Inactivity watchdog for a committed streaming turn. It is armed on commit
    // and RESET by every streaming event (partial/final transcript, assistant
    // text, assistant audio start + each audio frame, turn_progress keepalives).
    // If no event arrives for this long while a turn is in flight, the turn is
    // torn down with a visible + spoken timeout notice so the user is never left
    // in unexplained silence. Cleared on turn_done.
    //
    // 30s is the no-keepalive fallback: the gateway's reasoning budget is ~45s,
    // but it now emits turn_progress every ~5s during the reasoning and TTS legs,
    // so a healthy long answer re-arms well within 30s. An old gateway (no
    // keepalive) still gets a generous 30s before a false timeout.
    private static final long STREAMING_TURN_WATCHDOG_MS = 30000;
    private static final long CONTINUOUS_VOICE_RESTART_MS = 420;
    private static final long DEVICE_CLIENT_POLL_MS = 2500;
    private static final String OVERLAY_CHANNEL_ID = "moa_overlay";
    // Record mode: raw PCM16 mono at 16 kHz, capped at ~5 minutes per note.
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
    // Two surfaces hang off the orb. TAP opens the chat panel: a polished card
    // with bubbles + composer, the place to read the conversation and type.
    // DOUBLE-CLICK-AND-HOLD opens the voice surface: a compact native transcript
    // card showing live user words and the assistant response as separate rows.
    private View panelView;
    private LinearLayout messageColumn;
    private ScrollView messageScroll;
    private EditText composer;
    private TextView runStatusView;
    private View transcriptView;
    private LinearLayout voiceTranscriptColumn;
    private ScrollView voiceTranscriptScroll;
    private TextView voiceUserText;
    private TextView voiceAssistantText;
    private TextView voiceMetaLine;
    private View voiceUserRow;
    private View voiceAssistantRow;
    private VoiceRuntimeState voiceRuntimeState = VoiceRuntimeState.READY;
    private String voiceUserTranscript = "";
    private String voiceAssistantTranscript = "";
    private boolean voiceUserTranscriptFinal;
    private boolean voiceUserHiddenForAssistant;
    private boolean animateNextAssistantRow;
    private boolean currentStreamingAssistantRecorded;
    private Runnable pendingAutoDismiss;
    private Runnable pendingContinuousVoiceRestart;
    private Runnable pendingStreamingTurnWatchdog;
    // Shape of the current streaming turn, kept so a pre-commit failure can
    // silently restart the same kind of turn exactly once.
    private boolean streamingTurnAutoCommit;
    private boolean streamingTurnContinuous;
    private boolean streamingTurnRetried;
    private MoaVoiceController voiceController;
    private MoaStreamingVoiceSessionController streamingVoiceController;
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
    private final Map<String, AgentRunState> activeAgentRuns = new HashMap<>();
    private boolean agentRunPolling;
    private boolean nextManualVoiceFollowsActiveRun;
    private boolean nextStreamingTurnFollowsActiveRun;
    private String lastActiveAgentRunId = "";
    private int streamingVoiceGeneration;
    private boolean continuousVoiceLoop;
    private boolean pushToTalkVoiceTurn;
    // Record mode: while enabled, double-click-and-hold captures a raw audio
    // note locally and uploads it on release. Never a voice turn.
    private boolean recordModeEnabled;
    private boolean audioNoteActive;
    private MoaAudioCaptureController audioNoteCapture;
    private ByteArrayOutputStream audioNoteBuffer;
    // One shared warm microphone. The gesture warms it at the second-tap press so
    // the head of an utterance is buffered before the ~120ms hold confirms, then
    // hands it to whichever capture path the hold resolves to (streaming voice or
    // a record-mode note). Also pre-warmed during the continuous re-arm gap so a
    // hands-free turn does not pay a fresh AudioRecord cold-start. Null when idle.
    private MoaAudioCaptureController warmMic;
    private TextView recordModePill;
    // Context/thread controls (client-affordances lane). "New thread" arms a
    // one-shot so the NEXT sent turn (chat or voice) starts a fresh thread;
    // incognito is a persistent mode where every turn is answered but never
    // persisted by the gateway. Both are explicit client overrides that always
    // win over the model's own context choice.
    private boolean newThreadArmed;
    private boolean incognitoEnabled;
    private TextView newThreadPill;
    private TextView incognitoPill;
    private LinearLayout contextControlsRow;
    // The active streaming voice session runs on an inc- branch fixed at session
    // start via /v1/threads/switch; its turns are never persisted, so the reply
    // is marked "(not saved)".
    private boolean streamingTurnIncognito;
    // Guards the async /v1/threads/switch that resolves a branch before a
    // streaming voice session can open for an incognito / new-thread turn.
    private int streamingSwitchToken;
    private boolean streamingBranchSwitchPending;
    private boolean streamingCommitPendingOpen;
    private boolean pendingContinuousVoiceRestartAfterAudio;
    private boolean streamingAssistantAudioPlaying;
    // Whether any assistant audio frame actually played during the current
    // streaming turn. Drives the local TTS fallback when the gateway produced
    // text but never spoke it (for example am-ET replies with no hosted voice).
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
        voiceController = new MoaVoiceController(this, new MoaVoiceController.Callback() {
            @Override
            public void onVoiceStateChanged() {
                updateMicState();
            }

            @Override
            public void onShowPanelRequested() {
                // Voice never pops the chat panel. The panel is only for the
                // tap-to-type path. Voice shows the live transcript surface.
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
        // No sessions: never restore a prior conversation. Clear any history left
        // by an older build so the orb always starts fresh.
        MoaPrefs.setHistoryJson(this, "");
        promoteToForeground();
        showOrb();
        startDeviceClientLoop();
        adoptSharedSessionId();
    }

    // Join the gateway's canonical shared session so every surface (phone,
    // browser) writes into one conversation. Best-effort and off the main
    // thread: an offline or older gateway leaves the local id untouched.
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
                // Offline or a gateway without the shared-session route: keep the
                // existing local conversation id.
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
        running = false;
        cancelAudioNoteCapture();
        discardWarmMic();
        cancelStreamingTurnWatchdog();
        removeTranscriptOverlay();
        removePanel();
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
        updateVoiceHeaderState();
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
            try {
                MoaGatewayClient client = new MoaGatewayClient(url, token);
                JSONObject payload = client.agentProfile("device", deviceId);
                JSONObject profile = payload.optJSONObject("profile");
                if (profile != null) {
                    profileJson = profile.toString();
                }
                try {
                    JSONObject companion = client.activeCompanionPet("device", deviceId);
                    if (companion != null && companion.length() > 0) {
                        companionJson = companion.toString();
                    }
                } catch (Exception ignored) {
                }
            } catch (Exception ignored) {
                // Profile refresh is best-effort; cached/default language still works.
            }
            final String nextProfileJson = profileJson;
            final String nextCompanionJson = companionJson;
            mainHandler.post(() -> {
                if (!nextProfileJson.isEmpty()) {
                    MoaPrefs.setAgentProfileJson(this, nextProfileJson);
                }
                if (!nextCompanionJson.isEmpty()) {
                    MoaPrefs.setActiveCompanionJson(this, nextCompanionJson);
                }
                if (!nextProfileJson.isEmpty() || !nextCompanionJson.isEmpty()) {
                    applyCachedVoiceProfile();
                    updateAgentRunStatus();
                }
            });
        }, "moa-voice-profile").start();
    }

    // No sessions: live turns stay in memory only for the panel's current view.
    // They are never persisted, so a restart begins with a clean orb.
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
        orbView.setOnTouchListener(new MoaOrbTouchListener(
                this,
                windowManager,
                orbView,
                orbParams,
                ORB_WINDOW_DP,
                ORB_EDGE_MARGIN_DP,
                this::handleOrbSingleTap,
                this::handleOrbDoublePressStart,
                this::handleOrbVoicePressRelease,
                this::beginWarmMic,
                this::discardWarmMic
        ));

        windowManager.addView(orbView, orbParams);
    }

    private void removeOrb() {
        if (orbView != null) {
            windowManager.removeView(orbView);
            orbView = null;
        }
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

        loadSettings();

        panelView = createPanel();
        int width = Math.min(getResources().getDisplayMetrics().widthPixels - dp(20), dp(380));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width,
                WindowManager.LayoutParams.WRAP_CONTENT,
                overlayType(),
                // NOT_TOUCH_MODAL lets touches outside the panel reach the app
                // underneath; WATCH_OUTSIDE_TOUCH delivers those outside touches
                // to us as ACTION_OUTSIDE so the first tap off the panel closes
                // the overlay UI back to just the orb.
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        // Anchor to the top. The IME always rises from the bottom, so a top-
        // anchored panel keeps the composer visible above the keyboard without
        // fighting overlay resize behavior.
        params.gravity = Gravity.TOP | Gravity.END;
        params.x = dp(12);
        params.y = dp(64);
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;

        panelView.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == android.view.MotionEvent.ACTION_OUTSIDE) {
                dismissOverlayUi();
                return true;
            }
            return false;
        });

        windowManager.addView(panelView, params);
        panelOpen = true;
        renderMessages();
        animateSurfaceIn(panelView);
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

    private void animateSurfaceIn(View view) {
        view.setAlpha(0f);
        view.setTranslationY(dp(18));
        view.setScaleX(0.97f);
        view.setScaleY(0.97f);
        view.animate()
                .alpha(1f)
                .translationY(0f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(170)
                .setInterpolator(new android.view.animation.DecelerateInterpolator())
                .start();
    }

    private void removePanel() {
        if (panelView == null) {
            return;
        }
        hideKeyboard();
        final View dying = panelView;
        panelView = null;
        panelOpen = false;
        // Drop references so stale async callbacks (render, status) never write
        // into a detached panel.
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
                .withEndAction(() -> detachView(dying))
                .start();
    }

    private void detachView(View view) {
        if (view == null || view.getParent() == null) {
            return;
        }
        try {
            windowManager.removeView(view);
        } catch (IllegalArgumentException ignored) {
            // Already detached.
        }
    }

    private void hideKeyboard() {
        InputMethodManager inputMethodManager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (inputMethodManager != null && composer != null) {
            inputMethodManager.hideSoftInputFromWindow(composer.getWindowToken(), 0);
        }
    }

    // The voice surface is a compact transcript, not a transport log. It shows
    // what the user said and what Moa is saying, while connection/commit state
    // is rendered only as subtle surface state.
    private void showTranscriptOverlay(String value) {
        if (!Settings.canDrawOverlays(this)) {
            return;
        }
        String initialText = visibleVoiceContent(value);
        if (!initialText.isEmpty()) {
            voiceUserTranscript = initialText;
            voiceUserTranscriptFinal = false;
        }
        if (transcriptView != null) {
            renderVoiceTranscriptRows();
            return;
        }
        cancelAutoDismiss();

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(MoaDrawables.roundedGradient(0xF4101D18, 0xF40A1410, dp(24), 0x33F4D35E, dp(1)));
        card.setElevation(dp(26));
        card.setPadding(dp(16), dp(14), dp(16), dp(16));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            card.setOutlineSpotShadowColor(0xFF000000);
            card.setOutlineAmbientShadowColor(0xFF000000);
        }

        card.addView(createVoiceHeader());

        voiceTranscriptScroll = new CappedScrollView(this, dp(300));
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

        int width = Math.min(getResources().getDisplayMetrics().widthPixels, dp(560));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width,
                WindowManager.LayoutParams.WRAP_CONTENT,
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        params.y = dp(120);
        windowManager.addView(shell, params);
        transcriptView = shell;
        animateSurfaceIn(card);
    }

    private View createVoiceHeader() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(2), 0, dp(2), dp(8));

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
        updateVoiceHeaderState();
        return header;
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
        voiceUserTranscript = value;
        voiceUserTranscriptFinal = isFinal;
        voiceUserHiddenForAssistant = false;
        animateNextAssistantRow = false;
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
        voiceAssistantTranscript = value;
        if (transcriptView == null) {
            showTranscriptOverlay("");
        }
        setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
        if (!voiceUserHiddenForAssistant && voiceUserRow != null && !voiceUserTranscript.isEmpty()) {
            hideVoiceUserRowThenShowAssistant();
            return;
        }
        voiceUserHiddenForAssistant = true;
        renderVoiceTranscriptRows();
    }

    private void renderVoiceTranscriptRows() {
        if (voiceTranscriptColumn == null) {
            return;
        }
        voiceTranscriptColumn.removeAllViews();
        voiceUserText = null;
        voiceAssistantText = null;
        voiceUserRow = null;
        voiceAssistantRow = null;
        boolean showUser = voiceAssistantTranscript.isEmpty() || !voiceUserHiddenForAssistant;
        if (showUser) {
            voiceTranscriptColumn.addView(voiceMessageRow(false, voiceUserTranscript, voiceUserTranscriptFinal));
        }
        if (!voiceAssistantTranscript.isEmpty()) {
            voiceTranscriptColumn.addView(voiceMessageRow(true, voiceAssistantTranscript, true));
            if (animateNextAssistantRow && voiceAssistantRow != null) {
                animateNextAssistantRow = false;
                voiceAssistantRow.setAlpha(0f);
                voiceAssistantRow.setTranslationY(dp(8));
                voiceAssistantRow.animate()
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

    private void hideVoiceUserRowThenShowAssistant() {
        View row = voiceUserRow;
        if (row == null) {
            voiceUserHiddenForAssistant = true;
            animateNextAssistantRow = true;
            renderVoiceTranscriptRows();
            return;
        }
        row.animate()
                .alpha(0f)
                .translationY(-dp(8))
                .setDuration(VOICE_USER_EXIT_MS)
                .setInterpolator(new android.view.animation.AccelerateInterpolator())
                .withEndAction(() -> {
                    voiceUserHiddenForAssistant = true;
                    animateNextAssistantRow = true;
                    renderVoiceTranscriptRows();
                })
                .start();
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

        if (assistant) {
            voiceAssistantText = body;
            voiceAssistantRow = wrap;
        } else {
            voiceUserText = body;
            voiceUserRow = wrap;
        }
        return wrap;
    }

    private void setVoiceRuntimeState(VoiceRuntimeState state) {
        voiceRuntimeState = state == null ? VoiceRuntimeState.READY : state;
        updateVoiceHeaderState();
        // Single choke point for the orb's response state so the lion visibly
        // reflects thinking / responding / error without touching other call
        // sites. The watchdog + error paths become visible here for free.
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
        if (voiceMetaLine == null) {
            return;
        }
        String runStatus = agentRunStatusText();
        voiceMetaLine.setText("Ready".equals(runStatus) ? voiceStateLabel() : runStatus);
        voiceMetaLine.setTextColor(voiceStateColor());
    }

    private String voiceStateLabel() {
        String state;
        switch (voiceRuntimeState) {
            case LISTENING:
                state = "Listening";
                break;
            case SENDING:
                state = "Sending";
                break;
            case THINKING:
                state = "Thinking";
                break;
            case SPEAKING:
                state = "Speaking";
                break;
            case ERROR:
                state = "Error";
                break;
            case INTERRUPTED:
                state = "Interrupted";
                break;
            case RECOVERING:
                state = "Recovering";
                break;
            default:
                state = "Ready";
                break;
        }
        return state + " / " + MoaPrefs.companionName(this) + " / " + MoaPrefs.languageStatus(this);
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
        voiceTranscriptColumn = null;
        voiceTranscriptScroll = null;
        voiceUserText = null;
        voiceAssistantText = null;
        voiceUserRow = null;
        voiceAssistantRow = null;
        voiceMetaLine = null;
        dying.animate()
                .alpha(0f)
                .translationY(dp(12))
                .setDuration(140)
                .setInterpolator(new android.view.animation.AccelerateInterpolator())
                .withEndAction(() -> detachView(dying))
                .start();
    }

    // Voice cards are per-turn surfaces. After a response has been shown or
    // spoken, the card clears so the next turn does not show stale context.
    private void scheduleAutoDismiss(long delayMs) {
        cancelAutoDismiss();
        pendingAutoDismiss = () -> {
            pendingAutoDismiss = null;
            if (!streamingVoiceActive() && !voiceController.isActive() && voiceSamplePlayer == null) {
                removeTranscriptOverlay();
            }
        };
        mainHandler.postDelayed(pendingAutoDismiss, delayMs);
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
        } else {
            scheduleAutoDismiss(VOICE_RESPONSE_HOLD_MS);
        }
    }

    private void scheduleContinuousVoiceRestart(int generation) {
        cancelAutoDismiss();
        cancelContinuousVoiceRestart();
        // Warm the mic through the re-arm gap so the next hands-free turn opens on
        // an already-hot AudioRecord instead of paying a fresh cold-start. The
        // silence-VAD path drops the pre-roll on go-live, so this only removes
        // latency and never feeds stale gap audio into voice-activity detection.
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
        // Rounded dark card: a soft top-to-bottom gradient plus a hairline border
        // and real elevation so it reads as a raised surface, not a flat box.
        shell.setBackground(MoaDrawables.roundedGradient(0xF20D1A15, MoaColors.PANEL_BG, dp(26), MoaColors.PANEL_BORDER, dp(1)));
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

        TextView close = pill("Done", 0x16FFFFFF, MoaColors.MUTED);
        close.setOnClickListener(v -> dismissOverlayUi());
        header.addView(close);
        return header;
    }

    // Compact thread controls under the header. "New thread" arms a one-shot
    // fresh-thread state for the next turn; "Incognito" toggles a persistent
    // no-persistence mode. The row itself tints while incognito is on so the
    // state reads at a glance without opening the full app.
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

    // Arm/disarm the one-shot new-thread state. Re-tapping disarms it; it is also
    // consumed automatically once a turn rides on it.
    private void toggleNewThreadArmed() {
        newThreadArmed = !newThreadArmed;
        refreshContextControls();
    }

    // Toggle the persistent incognito mode on/off.
    private void toggleIncognito() {
        incognitoEnabled = !incognitoEnabled;
        refreshContextControls();
    }

    private void refreshContextControls() {
        if (newThreadPill != null) {
            boolean armed = newThreadArmed;
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
            boolean on = incognitoEnabled;
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
            contextControlsRow.setBackground(incognitoEnabled
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
        composer.setHintTextColor(0x66B8C9C2);
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

    private void renderMessages() {
        if (messageColumn == null) {
            return;
        }

        messageColumn.removeAllViews();
        if (messages.isEmpty()) {
            TextView empty = text(recordModeEnabled
                    ? "Record mode: double-click and hold to record a note."
                    : "Tap for chat. Double-click and hold to talk.", MoaColors.MUTED, 13, false);
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

    // Real chat bubbles. Assistant left, dark raised fill, hairline border, the
    // bottom-left corner tucked. User right, teal-violet tint, bottom-right
    // corner tucked. A small muted sender label sits above each.
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
            text = appendNotSaved(text);
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
                    deliverReply(reply.notSaved ? appendNotSaved(reply.text) : reply.text, fromVoice);
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
        if (incognitoEnabled) {
            body.put("context_action", "incognito");
            return;
        }
        if (newThreadArmed) {
            body.put("context_action", "new");
            newThreadArmed = false;
            refreshContextControls();
        }
    }

    private String appendNotSaved(String text) {
        String value = safe(text);
        if (value.isEmpty() || value.endsWith(NOT_SAVED_SUFFIX)) {
            return value;
        }
        return value + NOT_SAVED_SUFFIX;
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
        if (deviceClientPollInFlight) {
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
        JSONArray manifest = new JSONArray();
        putToolManifestItem(manifest, "app.launch", "navigation", "implicit_user_command");
        putToolManifestItem(manifest, "app.list", "read_only", "none");
        putToolManifestItem(manifest, "system.back", "navigation", "implicit_user_command");
        putToolManifestItem(manifest, "system.home", "navigation", "implicit_user_command");
        putToolManifestItem(manifest, "screen.summary", "read_only", "none");
        putToolManifestItem(manifest, "screen.tap_text", "navigation", "implicit_user_command");
        putToolManifestItem(manifest, "audio.speak", "local_output", "implicit_user_command");
        putToolManifestItem(manifest, "email.compose", "external_side_effect", "target_app_confirmation");
        putToolManifestItem(manifest, "sms.compose", "external_side_effect", "target_app_confirmation");
        return manifest;
    }

    private void putToolManifestItem(JSONArray manifest, String tool, String risk, String approval) throws JSONException {
        JSONObject item = new JSONObject();
        item.put("tool", tool);
        item.put("risk", risk);
        item.put("approval", approval);
        manifest.put(item);
    }

    private void executeClaimedToolRequest(JSONObject request) {
        String requestId = safe(request.optString("id", ""));
        String tool = safe(request.optString("tool", ""));
        JSONObject input = request.optJSONObject("input");
        if (input == null) {
            input = new JSONObject();
        }
        ToolRequestExecution execution;
        if ("audio.speak".equals(tool)) {
            execution = executeAudioSpeakRequest(input);
        } else {
            MoaActionBroker.ToolExecutionResult result = actionBroker.executeToolRequest(tool, input);
            execution = new ToolRequestExecution(result.success, result.reply, result.receipt);
        }

        String message = execution.success
                ? "Cross-device request completed: " + execution.summary
                : "Cross-device request failed: " + execution.summary;
        addMessage(true, message);
        if (!requestId.isEmpty()) {
            postToolRequestReceipt(requestId, execution);
        }
    }

    private ToolRequestExecution executeAudioSpeakRequest(JSONObject input) {
        String text = safe(input.optString("text", input.optString("message", input.optString("utterance", ""))));
        if (text.isEmpty()) {
            JSONObject receipt = MoaActionReceiptStore.record(this, "audio.speak", "local_output", "implicit_user_command", "", false, "Speech text is required.");
            return new ToolRequestExecution(false, "Speech text is required.", receipt);
        }
        boolean spoken = voiceController != null && voiceController.speak(text);
        // On-device TextToSpeech is disabled by policy (hosted TTS only), so this
        // path returns false by design. Report that plainly instead of implying a
        // broken/unavailable engine.
        String summary = spoken
                ? "Spoke requested text."
                : "On-device speech is disabled by policy; replies speak through hosted audio only.";
        JSONObject receipt = MoaActionReceiptStore.record(
                this,
                "audio.speak",
                "local_output",
                "implicit_user_command",
                "device_speaker",
                spoken,
                summary
        );
        return new ToolRequestExecution(spoken, summary, receipt);
    }

    private void postToolRequestReceipt(String requestId, ToolRequestExecution execution) {
        JSONObject body = new JSONObject();
        try {
            body.put("device_id", androidDeviceId());
            body.put("ok", execution.success);
            body.put("summary", execution.summary);
            if (!execution.success) {
                body.put("error", execution.summary);
            }
            JSONObject result = new JSONObject();
            result.put("reply", execution.summary);
            body.put("result", result);
            if (execution.receipt != null) {
                body.put("local_receipt", execution.receipt);
            }
        } catch (JSONException error) {
            return;
        }

        final String url = gatewayUrl;
        final String token = gatewayToken;
        new Thread(() -> {
            try {
                new MoaGatewayClient(url, token).toolRequestReceipt(requestId, body);
            } catch (Exception ignored) {
                // The local action already happened and was recorded locally.
            }
        }, "moa-tool-receipt").start();
    }

    private void trackAgentRunsFromResponse(JSONObject response) {
        if (response == null) {
            return;
        }

        JSONObject run = response.optJSONObject("run");
        if (run != null) {
            trackAgentRun(run);
        }

        JSONObject singleRun = response.optJSONObject("agent_run");
        if (singleRun != null) {
            trackAgentRun(singleRun);
        }

        JSONArray runs = response.optJSONArray("agent_runs");
        if (runs != null) {
            for (int i = 0; i < runs.length(); i++) {
                JSONObject item = runs.optJSONObject(i);
                if (item != null) {
                    trackAgentRun(item);
                }
            }
        }

        updateAgentRunStatus();
        ensureAgentRunPolling();
    }

    private void trackAgentRun(JSONObject run) {
        String id = safe(run.optString("id", ""));
        if (id.isEmpty()) {
            return;
        }

        AgentRunState state = activeAgentRuns.get(id);
        if (state == null) {
            state = new AgentRunState(id);
            activeAgentRuns.put(id, state);
        }
        lastActiveAgentRunId = id;
        state.harness = safe(run.optString("harness", state.harness));
        state.status = safe(run.optString("status", state.status));
        state.outputPreview = safe(run.optString("output_preview", state.outputPreview));
        state.active = run.optBoolean("active", isActiveRunStatus(state.status));
    }

    private void ensureAgentRunPolling() {
        if (agentRunPolling || activeAgentRuns.isEmpty()) {
            return;
        }
        agentRunPolling = true;
        mainHandler.postDelayed(this::pollAgentRunsOnce, 1200);
    }

    private void pollAgentRunsOnce() {
        if (activeAgentRuns.isEmpty()) {
            agentRunPolling = false;
            updateAgentRunStatus();
            return;
        }

        List<String> ids = new ArrayList<>(activeAgentRuns.keySet());
        new Thread(() -> {
            List<AgentRunState> updates = new ArrayList<>();
            for (String id : ids) {
                try {
                    JSONObject response = gatewayClient().agentRunDetail(id);
                    JSONObject run = response.optJSONObject("run");
                    if (run != null) {
                        AgentRunState state = new AgentRunState(id);
                        state.harness = safe(run.optString("harness", ""));
                        state.status = safe(run.optString("status", ""));
                        state.outputPreview = safe(run.optString("output_preview", ""));
                        state.active = run.optBoolean("active", isActiveRunStatus(state.status));
                        updates.add(state);
                    }
                } catch (Exception error) {
                    AgentRunState state = new AgentRunState(id);
                    state.status = "unknown";
                    state.outputPreview = cleanError(error);
                    state.active = false;
                    updates.add(state);
                }
            }
            mainHandler.post(() -> applyAgentRunUpdates(updates));
        }, "moa-agent-run-poll").start();
    }

    private void applyAgentRunUpdates(List<AgentRunState> updates) {
        for (AgentRunState update : updates) {
            AgentRunState previous = activeAgentRuns.get(update.id);
            if (previous == null) {
                continue;
            }
            previous.harness = update.harness.isEmpty() ? previous.harness : update.harness;
            previous.status = update.status.isEmpty() ? previous.status : update.status;
            previous.outputPreview = update.outputPreview;
            previous.active = update.active;
            if (isTerminalRunStatus(previous.status)) {
                addMessage(true, agentRunCompletionText(previous));
                activeAgentRuns.remove(previous.id);
            }
        }
        updateAgentRunStatus();
        if (activeAgentRuns.isEmpty()) {
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
        if (!lastActiveAgentRunId.isEmpty() && activeAgentRuns.containsKey(lastActiveAgentRunId)) {
            return lastActiveAgentRunId;
        }
        for (String id : activeAgentRuns.keySet()) {
            return id;
        }
        return "";
    }

    private String agentRunStatusText() {
        if (activeAgentRuns.isEmpty()) {
            return "Ready";
        }

        int running = 0;
        for (AgentRunState state : activeAgentRuns.values()) {
            if (state.active || isActiveRunStatus(state.status)) {
                running++;
            }
        }
        int count = running > 0 ? running : activeAgentRuns.size();
        return count == 1 ? "1 run active" : count + " runs active";
    }

    private String agentRunCompletionText(AgentRunState state) {
        String id = state.id.length() > 10 ? state.id.substring(0, 10) : state.id;
        String base = "Run " + id + " " + state.status + ".";
        if (!state.outputPreview.isEmpty()) {
            return base + "\n" + state.outputPreview;
        }
        return base;
    }

    private boolean isActiveRunStatus(String status) {
        String value = safe(status);
        return value.isEmpty() || "queued".equals(value) || "running".equals(value);
    }

    private boolean isTerminalRunStatus(String status) {
        String value = safe(status);
        return "completed".equals(value)
                || "failed".equals(value)
                || "timed-out".equals(value)
                || "timed_out".equals(value)
                || "timeout".equals(value)
                || "canceled".equals(value)
                || "unknown".equals(value);
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

    // TAP the orb = chat menu. Voice is reserved for double-click-and-hold, so
    // a normal click never commits, stops, or starts a spoken turn.
    private void handleOrbSingleTap() {
        showPanel();
    }

    private void startPushToTalkVoiceTurn() {
        if (streamingVoiceActive() || voiceController.isActive() || voiceSamplePlayer != null || continuousVoiceLoop || pendingContinuousVoiceRestart != null) {
            dismissOverlayUi();
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
            nextStreamingTurnFollowsActiveRun = !activeAgentRuns.isEmpty();
            nextManualVoiceFollowsActiveRun = false;
            startStreamingVoiceTurn(false, false);
            return;
        }
        startLocalVoiceTurn(true);
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
            if (streamingVoiceActive()) {
                cancelStreamingVoice();
            }
            String failure = "The voice turn timed out.";
            updateVoiceAssistantTranscript(failure);
            speakOverlayNotice(failure);
            setVoiceRuntimeState(VoiceRuntimeState.ERROR);
            continuousVoiceLoop = false;
            updateMicState();
            scheduleAutoDismiss(VOICE_RESPONSE_HOLD_MS);
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
        if (nextStreamingTurnFollowsActiveRun || !activeAgentRuns.isEmpty()) {
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
        cancelAudioNoteCapture();
        discardWarmMic();
        pushToTalkVoiceTurn = false;
        continuousVoiceLoop = false;
        nextManualVoiceFollowsActiveRun = false;
        invalidatePendingBranchSwitch();
        cancelContinuousVoiceRestart();
        if (streamingVoiceActive()) {
            cancelStreamingVoice();
        }
        cancelVoiceSampler();
        voiceController.stopQuietly();
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
            dismissOverlayUi();
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
        resetVoiceTurnTranscript();
        showTranscriptOverlay("");
        updateVoiceAssistantTranscript(message);
        setVoiceRuntimeState(failed ? VoiceRuntimeState.ERROR : VoiceRuntimeState.READY);
        updateMicState();
        scheduleAutoDismiss(VOICE_RESPONSE_HOLD_MS * 2);
    }

    private void startLocalVoiceTurn(boolean manualCommitOnly) {
        // The local SpeechRecognizer path does not use our AudioRecord, so a mic
        // warmed by the gesture would leak (indicator stuck on). Drop it here.
        discardWarmMic();
        continuousVoiceLoop = false;
        cancelContinuousVoiceRestart();
        if (streamingVoiceActive()) {
            cancelStreamingVoice();
        }
        cancelVoiceSampler();
        if (orbView != null) {
            orbView.setHeld(true);
        }
        nextManualVoiceFollowsActiveRun = !activeAgentRuns.isEmpty();
        nextStreamingTurnFollowsActiveRun = !activeAgentRuns.isEmpty();
        resetVoiceTurnTranscript();
        showTranscriptOverlay("");
        setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
        voiceController.startCommandListening(manualCommitOnly);
    }

    private boolean streamingVoiceAvailable() {
        return !safe(gatewayUrl).isEmpty() && !safe(gatewayToken).isEmpty();
    }

    private void cancelStreamingVoice() {
        pushToTalkVoiceTurn = false;
        continuousVoiceLoop = false;
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
            startLocalVoiceTurn(false);
            return;
        }
        startStreamingVoiceTurn(true, true);
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
        String contextAction = incognitoEnabled ? "incognito" : (newThreadArmed ? "new" : "");
        if (contextAction.isEmpty()) {
            openStreamingVoiceSession(autoCommitOnSilence, continuousLoop, "default", false);
            return;
        }
        resolveThreadBranchThenOpenStreamingVoice(autoCommitOnSilence, continuousLoop, contextAction);
    }

    // Resolve the thread branch for an incognito / new-thread streaming voice turn
    // off the main thread, then open the session on the returned branch. The fast
    // (default-branch) path never enters here, so ordinary voice keeps its
    // immediate socket connect. An incognito switch that fails is surfaced rather
    // than silently opening a persisted session, keeping the incognito guarantee.
    private void resolveThreadBranchThenOpenStreamingVoice(boolean autoCommit, boolean continuous, String action) {
        final boolean incognito = "incognito".equals(action);
        // Consume the one-shot "new" arm now that we are acting on it; incognito
        // is a persistent mode and stays on.
        if (!incognito) {
            newThreadArmed = false;
            refreshContextControls();
        }
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
                    scheduleAutoDismiss(VOICE_RESPONSE_HOLD_MS);
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
                    if (nextStreamingTurnFollowsActiveRun || !activeAgentRuns.isEmpty()) {
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
        voiceUserTranscript = "";
        voiceAssistantTranscript = "";
        voiceUserTranscriptFinal = false;
        voiceUserHiddenForAssistant = false;
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

    // Local TTS fallback for the streaming path. When a completed turn produced
    // assistant text but the gateway did not speak it (tts_spoke false or no
    // assistant audio ever played), speak it with the on-device engine, mirroring
    // the HTTP path's speak gate (quiet mode + idle engine). Returns true when
    // local speech started, so the caller lets onSpokenReplyFinished drive the
    // ready/restart flow.
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
        scheduleAutoDismiss(dismissDelayMs);
    }

    // Append a small "(not spoken)" marker to the visible assistant reply. The
    // stored chat message was already recorded before this runs, so only the
    // overlay row shows the marker; history stays clean.
    private void markCurrentReplyNotSpoken() {
        String text = safe(voiceAssistantTranscript);
        if (text.isEmpty() || text.endsWith(NOT_SPOKEN_SUFFIX)) {
            return;
        }
        updateVoiceAssistantTranscript(text + NOT_SPOKEN_SUFFIX);
    }

    // Append the "(not saved)" marker to the streaming reply of an incognito
    // voice session (its inc- branch is never persisted). The stored chat message
    // was already recorded before this runs, so only the overlay row shows it.
    private void markCurrentReplyNotSaved() {
        String text = safe(voiceAssistantTranscript);
        if (text.isEmpty() || text.endsWith(NOT_SAVED_SUFFIX)) {
            return;
        }
        updateVoiceAssistantTranscript(text + NOT_SAVED_SUFFIX);
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

    // Warm the shared mic on the second-tap press so the ~500ms pre-roll captures
    // the head of the utterance before the hold confirms. Only when a gateway-
    // backed capture path could consume it: the local SpeechRecognizer fallback
    // does not use our AudioRecord, so warming there would light the mic
    // indicator for nothing. Idempotent: a no-op while already warm.
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

    // The gesture resolved to a drag or an early release before the hold
    // confirmed: stop the warm mic and drop its pre-roll so the indicator turns
    // off and nothing is captured. Safe to call when no mic is warm.
    private void discardWarmMic() {
        if (warmMic != null) {
            warmMic.stop();
            warmMic = null;
        }
    }

    // Hand the already-running warm mic to the capture path the hold resolved to.
    // Ownership transfers to the caller (session or audio note), which stops it.
    // Returns null when nothing was warmed, in which case the caller cold-starts.
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

    private static final class AgentRunState {
        final String id;
        String harness = "";
        String status = "queued";
        String outputPreview = "";
        boolean active = true;

        AgentRunState(String id) {
            this.id = id == null ? "" : id.trim();
        }
    }

}

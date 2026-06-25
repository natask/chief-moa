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
    private static final long CONTINUOUS_VOICE_RESTART_MS = 420;
    private static final String OVERLAY_CHANNEL_ID = "moa_overlay";

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
    private final Map<String, AgentRunState> activeAgentRuns = new HashMap<>();
    private boolean agentRunPolling;
    private boolean nextManualVoiceFollowsActiveRun;
    private boolean nextStreamingTurnFollowsActiveRun;
    private String lastActiveAgentRunId = "";
    private int streamingVoiceGeneration;
    private boolean continuousVoiceLoop;
    private boolean pushToTalkVoiceTurn;
    private boolean pendingContinuousVoiceRestartAfterAudio;
    private boolean streamingAssistantAudioPlaying;

    private enum VoiceRuntimeState {
        READY,
        LISTENING,
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
        // No sessions: never restore a prior conversation. Clear any history left
        // by an older build so the orb always starts fresh.
        MoaPrefs.setHistoryJson(this, "");
        promoteToForeground();
        showOrb();
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
        removeTranscriptOverlay();
        removePanel();
        removeOrb();
        agentRunPolling = false;
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
                "Aggie overlay",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the Aggie overlay available above other apps.");
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
                .setContentTitle("Aggie overlay")
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
                this::handleOrbVoicePressRelease
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
            updateVoiceAssistantTranscript("Screen access is off. Enable it in Aggie settings.");
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

        TextView label = text(assistant ? "Aggie" : "You", assistant ? MoaColors.GOLD : 0xFFBFA9FF, 10, true);
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
        switch (voiceRuntimeState) {
            case LISTENING:
                return "Listening";
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
                return "";
        }
    }

    private int voiceStateColor() {
        switch (voiceRuntimeState) {
            case ERROR:
                return MoaColors.EMBER;
            case INTERRUPTED:
            case RECOVERING:
                return MoaColors.GOLD;
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

        TextView label = text("Aggie", MoaColors.PAPER, 17, true);
        label.setLetterSpacing(0.02f);
        copy.addView(label);
        runStatusView = text(agentRunStatusText(), MoaColors.MUTED, 11, false);
        copy.addView(runStatusView);
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView close = pill("Done", 0x16FFFFFF, MoaColors.MUTED);
        close.setOnClickListener(v -> dismissOverlayUi());
        header.addView(close);
        return header;
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
        composer.setHint("Message Aggie");
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
            TextView empty = text("Tap for chat. Double-click and hold to talk.", MoaColors.MUTED, 13, false);
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

        TextView label = text(message.assistant ? "Aggie" : "You", message.assistant ? MoaColors.GOLD : 0xFFBFA9FF, 10, true);
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
            mainHandler.postDelayed(() -> deliverReply(replyFor(text), fromVoice), 240);
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
            return;
        }

        boolean shouldSpeak = fromVoice && !speakText.isEmpty();
        boolean speaking = false;
        addMessage(true, text);
        if (fromVoice) {
            updateVoiceAssistantTranscript(text);
            setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
        }
        trackAgentRunsFromResponse(response);
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
                    String failure = "Voice sampler failed: " + safe(message);
                    addMessage(true, failure);
                    updateVoiceAssistantTranscript(failure);
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
            deliverReply(replyFor(userText), fromVoice);
            return;
        }

        new Thread(() -> {
            try {
                MoaGatewayClient.GatewayTextResponse reply = gatewayClient().chat(requestBody);
                mainHandler.post(() -> {
                    updateConversationId(reply.conversationId);
                    deliverReply(reply.text, fromVoice);
                });
            } catch (Exception error) {
                String fallback = replyFor(userText) + "\n\nGateway unavailable: " + cleanError(error) + ".";
                mainHandler.post(() -> deliverReply(fallback, fromVoice));
            }
        }, "moa-gateway").start();
    }

    private void requestAgentRun(String prompt, boolean fromVoice) {
        if (gatewayUrl.isEmpty()) {
            deliverReply("Agent actions need the Aggie gateway. Set the home-machine URL first.", fromVoice);
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
                String fallback = "Home-machine agent run failed: " + cleanError(error) + ".";
                mainHandler.post(() -> deliverReply(fallback, fromVoice));
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
                String fallback = "Agent follow-up failed: " + cleanError(error) + ".";
                mainHandler.post(() -> deliverReply(fallback, fromVoice, false));
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
        return body;
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
            runStatusView.setText(agentRunStatusText());
        }
        updateVoiceHeaderState();
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
        return "The user spoke this from the Aggie Android overlay and expects forward progress, not a chat-only answer.\n\n"
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

    private String replyFor(String prompt) {
        String lower = prompt.toLowerCase(Locale.US);
        if (lower.contains("overlay") || lower.contains("screen")) {
            return "I am already running as an Android overlay. The circle stays over the current app, and the panel opens only when you summon it.";
        }
        if (lower.contains("voice") || lower.contains("mic") || lower.contains("talk")) {
            return "Voice input streams through Gemini Live from the overlay. If an agent is active, the next spoken turn is sent to that agent thread.";
        }
        if (lower.contains("deploy") || lower.contains("apk") || lower.contains("install")) {
            return "Build the debug APK with ./gradlew assembleDebug, then install it with adb install app/build/outputs/apk/debug/app-debug.apk.";
        }
        if (lower.contains("gemini") || lower.contains("replace")) {
            return "The replacement shape is clear: one always-available Aggie circle, local overlay controls, voice capture, and your model gateway behind it.";
        }
        return "I heard you. The product loop is: capture the command fast, keep context from the current screen, answer in place, and stay out of the way.";
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
        pushToTalkVoiceTurn = true;
        startLocalVoiceTurn(true);
    }

    private void handleOrbVoicePressRelease() {
        if (!pushToTalkVoiceTurn) {
            return;
        }
        pushToTalkVoiceTurn = false;
        if (orbView != null) {
            orbView.setHeld(false);
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
        setVoiceRuntimeState(VoiceRuntimeState.THINKING);
        updateMicState();
        if (routeCommittedStreamingTranscriptIfNeeded(transcript)) {
            return;
        }
        controller.commitTurn();
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
        pushToTalkVoiceTurn = false;
        continuousVoiceLoop = false;
        nextManualVoiceFollowsActiveRun = false;
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
    private void handleOrbDoublePressStart() {
        startPushToTalkVoiceTurn();
    }

    private void startLocalVoiceTurn(boolean manualCommitOnly) {
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
        cancelContinuousVoiceRestart();
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
        Log.i(TAG, "startStreamingVoiceTurn autoCommit=" + autoCommitOnSilence
                + " continuousLoop=" + continuousLoop
                + " gatewayConfigured=" + !safe(gatewayUrl).isEmpty()
                + " token=" + (safe(gatewayToken).isEmpty() ? "missing" : "set"));
        cancelContinuousVoiceRestart();
        if (streamingVoiceController != null) {
            streamingVoiceController.destroy();
        }
        continuousVoiceLoop = continuousLoop;
        final int generation = ++streamingVoiceGeneration;
        currentStreamingTurnRouted = false;
        currentStreamingTurnCommitRequested = false;
        currentStreamingAssistantRecorded = false;
        currentStreamingTranscript = "";
        streamingAssistantAudioPlaying = false;
        resetVoiceTurnTranscript();
        final String stableSessionId = conversationId.isEmpty() ? MoaPrefs.conversationId(this) : conversationId;
        updateConversationId(stableSessionId);
        streamingVoiceController = new MoaStreamingVoiceSessionController(gatewayUrl, gatewayToken, MoaPrefs.spokenRepliesEnabled(this), stableSessionId, "default", autoCommitOnSilence, new MoaStreamingVoiceSessionController.Callback() {
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
                setVoiceRuntimeState(VoiceRuntimeState.LISTENING);
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
                setVoiceRuntimeState(VoiceRuntimeState.THINKING);
                updateMicState();
            }

            @Override
            public void onTranscriptPartial(String turnId, String text) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                currentStreamingTranscript = safe(text);
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
                String transcript = safe(text);
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
                if (currentStreamingTurnRouted) {
                    return;
                }
                if (!safe(text).isEmpty()) {
                    updateVoiceAssistantTranscript(text);
                }
            }

            @Override
            public void onAssistantAudioStarted(String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                if (currentStreamingTurnRouted) {
                    return;
                }
                streamingAssistantAudioPlaying = true;
                setVoiceRuntimeState(VoiceRuntimeState.SPEAKING);
                updateMicState();
            }

            @Override
            public void onAssistantAudioDone(String turnId) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
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
            public void onTurnDone(String turnId, String status, boolean transcriptionOnly) {
                if (!isCurrentStreamingGeneration(generation)) {
                    return;
                }
                if (transcriptionOnly && !currentStreamingTurnRouted && !currentStreamingTranscript.isEmpty()) {
                    routeStreamingTranscriptThroughMoa(currentStreamingTranscript, !voiceUserTranscriptFinal);
                    return;
                }
                if (!currentStreamingTurnRouted) {
                    nextStreamingTurnFollowsActiveRun = false;
                    recordCurrentStreamingAssistant();
                }
                if ("completed".equals(safe(status))) {
                    if (streamingAssistantAudioPlaying) {
                        pendingContinuousVoiceRestartAfterAudio = true;
                        return;
                    }
                    showReadyForNextVoiceTurn(generation);
                    return;
                }
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
                if (currentStreamingTurnRouted) {
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
                nextStreamingTurnFollowsActiveRun = false;
                if (isRecoverableStreamingVoiceError(message)) {
                    recoverStreamingVoiceTurn(generation);
                    return;
                }
                String failure = "Streaming voice failed: " + message;
                addMessage(true, failure);
                updateVoiceAssistantTranscript(failure);
                setVoiceRuntimeState(VoiceRuntimeState.ERROR);
                continuousVoiceLoop = false;
                mainHandler.postDelayed(() -> {
                    if (isCurrentStreamingGeneration(generation)) {
                        showReadyForNextVoiceTurn(generation);
                    }
                }, 900);
            }
        });
        streamingVoiceController.startSession();
    }

    private boolean isRecoverableStreamingVoiceError(String message) {
        String normalized = safe(message).toLowerCase(Locale.US);
        return normalized.contains("gemini-live generation was interrupted")
                || normalized.contains("failed to complete turn: gemini-live");
    }

    private void recoverStreamingVoiceTurn(int generation) {
        Log.i(TAG, "recovering from interrupted streaming voice turn");
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
        setVoiceRuntimeState(VoiceRuntimeState.READY);
        updateMicState();
        if (continuousVoiceLoop && generation == streamingVoiceGeneration) {
            scheduleContinuousVoiceRestart(generation);
            return;
        }
        scheduleAutoDismiss(VOICE_RESPONSE_HOLD_MS);
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

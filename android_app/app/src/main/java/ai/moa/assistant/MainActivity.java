package ai.moa.assistant;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.TreeSet;

public final class MainActivity extends Activity {
    static final String EXTRA_GATEWAY_URL = "ai.moa.assistant.extra.GATEWAY_URL";
    static final String EXTRA_GATEWAY_TOKEN = "ai.moa.assistant.extra.GATEWAY_TOKEN";
    static final String EXTRA_START_OVERLAY = "ai.moa.assistant.extra.START_OVERLAY";
    static final String EXTRA_REVIEW_UPDATE = "ai.moa.assistant.extra.REVIEW_UPDATE";
    // Double-tapping an overlay ribbon opens history here, as a real window. The
    // overlay stays alive behind it and never becomes a scrollback itself.
    static final String EXTRA_SHOW_HISTORY = "ai.moa.assistant.extra.SHOW_HISTORY";

    // Overlay contract: the overlay agent handles this action to re-read the
    // stored orb scale. Kept as a literal so the main app builds even before the
    // overlay side lands its OverlayService.ACTION_REFRESH_ORB_SCALE constant.
    private static final String ACTION_REFRESH_ORB_SCALE = "ai.moa.assistant.REFRESH_ORB_SCALE";

    private static final int REQUEST_AUDIO = 4101;
    private static final int REQUEST_CONTACTS = 4102;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private TextView overlayStatus;
    private TextView accessibilityStatus;
    private TextView mediaStatus;
    private TextView micStatus;
    private TextView gatewayStatus;
    private TextView updateStatus;
    private TextView requirementsSummary;
    private TextView sessionsStatus;
    private ScrollView contentScroll;
    private TextView sessionHistoryStatus;
    private LinearLayout sessionHistoryColumn;
    private TextView runsStatus;
    private TextView receiptsStatus;
    private TextView settingsStatus;
    private TextView companionStatus;
    private TextView voiceE2eStatus;
    private TextView orbScaleValue;
    private Button overlayButton;
    private Button accessibilityButton;
    private Button mediaAccessButton;
    private Button appInfoButton;
    private Button micButton;
    private Button contactsButton;
    private Button startButton;
    private Button stopButton;
    private Button updateButton;
    private Button rollbackButton;
    private EditText gatewayUrlInput;
    private EditText gatewayTokenInput;
    private EditText preferredYoutubeInput;
    private CheckBox spokenRepliesInput;
    private JSONObject pendingUpdate;
    private MoaUpdatePolicy.RollbackOption pendingRollback;
    private boolean autoStartedOverlay;
    private boolean requestedMicOnStartup;
    private int gatewayHealthGeneration;
    private int controlCenterGeneration;
    private int updateCheckGeneration;
    private int releaseInstallGeneration;
    private long updateDialogVersionCode;
    private boolean reviewUpdateOnNextCheck;
    private MoaReleaseCardController releaseController;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(MoaColors.SURFACE_0);
        window.setNavigationBarColor(MoaColors.SURFACE_0);

        applyIntentConfiguration(getIntent());
        releaseController = createReleaseController();
        setContentView(createContent());
        maybeRequestMicPermission();
        scrollToHistoryIfRequested(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyIntentConfiguration(intent);
        if (gatewayUrlInput != null) {
            gatewayUrlInput.setText(MoaPrefs.gatewayUrl(this));
        }
        if (gatewayTokenInput != null) {
            gatewayTokenInput.setText(MoaPrefs.gatewayToken(this));
        }
        updatePermissionState();
        maybeRequestMicPermission();
        scrollToHistoryIfRequested(intent);
        if (Settings.canDrawOverlays(this) && OverlayService.isRunning()) {
            collapseOverlaySurfaces();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        updatePermissionState();
        if (Settings.canDrawOverlays(this) && OverlayService.isRunning()) {
            collapseOverlaySurfaces();
        }
        if (!autoStartedOverlay && Settings.canDrawOverlays(this)) {
            autoStartedOverlay = true;
            startOverlay();
        }
        Intent intent = getIntent();
        if (intent != null && intent.getBooleanExtra(EXTRA_START_OVERLAY, false) && Settings.canDrawOverlays(this)) {
            startOverlay();
            intent.removeExtra(EXTRA_START_OVERLAY);
        }
    }

    @Override
    protected void onDestroy() {
        releaseInstallGeneration++;
        if (releaseController != null) releaseController.close();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_AUDIO || requestCode == REQUEST_CONTACTS) {
            updatePermissionState();
        }
    }

    private void scrollToHistoryIfRequested(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_SHOW_HISTORY, false)) {
            return;
        }
        intent.removeExtra(EXTRA_SHOW_HISTORY);
        if (contentScroll == null || sessionHistoryStatus == null) {
            return;
        }
        final ScrollView scroll = contentScroll;
        final View anchor = sessionHistoryStatus;
        scroll.post(() -> scroll.smoothScrollTo(0, anchor.getTop()));
        refreshControlCenter();
    }

    private View createContent() {
        ScrollView scrollView = new ScrollView(this);
        contentScroll = scrollView;
        scrollView.setFillViewport(true);
        scrollView.setBackgroundColor(MoaColors.SURFACE_0);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(30), dp(20), dp(26));
        scrollView.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        root.addView(heroBrand());

        root.addView(statusCard());
        root.addView(gatewayCard());
        root.addView(controlCenterCard());
        root.addView(releaseController.createView());
        root.addView(actionCard());
        root.addView(orbSizeCard());
        root.addView(gesturesCard());

        return scrollView;
    }

    private View heroBrand() {
        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.HORIZONTAL);
        hero.setGravity(Gravity.CENTER_VERTICAL);

        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.moa_mark);
        // Same opaque disc as the floating orb so the lion's dark eyes read here
        // too, instead of relying on the incidentally-dark root behind it.
        mark.setBackground(MoaDrawables.circle(MoaColors.MARK_BACKING, MoaColors.RAISED_BORDER, dp(1)));
        mark.setPadding(dp(6), dp(6), dp(6), dp(6));
        LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(46), dp(46));
        markParams.rightMargin = dp(12);
        mark.setLayoutParams(markParams);
        hero.addView(mark);

        LinearLayout text = new LinearLayout(this);
        text.setOrientation(LinearLayout.VERTICAL);

        TextView eyebrow = label("ANDROID ASSISTANT", MoaColors.GOLD, 11, true);
        eyebrow.setLetterSpacing(0.14f);
        text.addView(eyebrow);

        TextView title = label("A.G.", MoaColors.PAPER, 30, true);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        text.addView(title);

        hero.addView(text);

        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.addView(hero);

        TextView subtitle = label("Your assistant, above every app.", MoaColors.MUTED, 15, false);
        subtitle.setPadding(0, dp(10), 0, dp(2));
        wrap.addView(subtitle);
        return wrap;
    }

    private View statusCard() {
        LinearLayout card = card();
        addCardTitle(card, "Required access");

        overlayStatus = accessRow(card, "Screen overlay", "Checking...");
        accessibilityStatus = accessRow(card, "Screen access", "Checking...");
        mediaStatus = accessRow(card, "Media control", "Checking...");
        micStatus = accessRow(card, "Microphone", "Checking...");
        gatewayStatus = accessRow(card, "Model gateway", "Checking...");
        updateStatus = accessRow(card, "App update", "Checking...");

        requirementsSummary = label("", MoaColors.MUTED, 13, false);
        requirementsSummary.setLineSpacing(dp(2), 1f);
        requirementsSummary.setPadding(0, dp(12), 0, 0);
        requirementsSummary.setVisibility(View.GONE);
        card.addView(requirementsSummary);
        return card;
    }

    private View controlCenterCard() {
        LinearLayout card = card();
        addCardTitle(card, "Control center");

        sessionsStatus = statRow(card, "Shared session", "Checking...");
        runsStatus = statRow(card, "Runs", "Checking...");
        receiptsStatus = statRow(card, "Receipts", "Checking...");
        settingsStatus = statRow(card, "Settings", settingsSummaryText());
        companionStatus = statRow(card, "Companion", MoaPrefs.companionStatus(this));
        voiceE2eStatus = statRow(card, "Mobile voice E2E", MoaVoiceE2eMetricsStore.summary(this));

        sessionHistoryStatus = label("Recent shared history", MoaColors.MUTED, 12, true);
        sessionHistoryStatus.setPadding(0, dp(14), 0, dp(8));
        card.addView(sessionHistoryStatus);

        ScrollView historyScroll = new ScrollView(this);
        historyScroll.setFillViewport(false);
        historyScroll.setBackground(MoaDrawables.rounded(
                MoaColors.COMPOSER_BG, dp(14), MoaColors.COMPOSER_BORDER, dp(1)));
        LinearLayout.LayoutParams historyParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(420));
        historyScroll.setLayoutParams(historyParams);

        sessionHistoryColumn = new LinearLayout(this);
        sessionHistoryColumn.setOrientation(LinearLayout.VERTICAL);
        sessionHistoryColumn.setPadding(dp(12), dp(8), dp(12), dp(12));
        historyScroll.addView(sessionHistoryColumn, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        card.addView(historyScroll);
        renderSessionHistory(null, "Loading shared history...");

        Button refresh = secondaryButton("Refresh");
        refresh.setOnClickListener(v -> refreshControlCenter());
        card.addView(refresh);
        return card;
    }

    private View gatewayCard() {
        LinearLayout card = card();
        addCardTitle(card, "Voice agent setup");

        TextView caption = label("Keys stay on your server.", MoaColors.MUTED, 12, false);
        caption.setPadding(0, 0, 0, dp(10));
        card.addView(caption);

        gatewayUrlInput = textInput("Gateway URL", MoaPrefs.gatewayUrl(this), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card.addView(gatewayUrlInput);

        gatewayTokenInput = textInput("Gateway token (optional)", MoaPrefs.gatewayToken(this), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        card.addView(gatewayTokenInput);

        preferredYoutubeInput = textInput(
                "Preferred YouTube package",
                MoaPrefs.preferredYoutubePackage(this),
                InputType.TYPE_CLASS_TEXT);
        card.addView(preferredYoutubeInput);

        spokenRepliesInput = new CheckBox(this);
        spokenRepliesInput.setText("Play spoken replies");
        spokenRepliesInput.setTextColor(MoaColors.PAPER);
        spokenRepliesInput.setTextSize(15);
        spokenRepliesInput.setChecked(MoaPrefs.spokenRepliesEnabled(this));
        spokenRepliesInput.setPadding(0, dp(8), 0, dp(4));
        card.addView(spokenRepliesInput);

        Button saveButton = primaryButton("Save settings");
        saveButton.setOnClickListener(v -> saveGatewaySettings());
        card.addView(saveButton);

        updateButton = secondaryButton("Check for app update");
        updateButton.setOnClickListener(v -> {
            if (pendingUpdate != null) {
                showUpdateDecisionDialog(pendingUpdate);
            } else {
                checkForAppUpdate(true);
            }
        });
        card.addView(updateButton);

        // Restore-previous-version lives here in the full app, never in the
        // overlay. It is hidden until the gateway offers a verified rollback and
        // only ever runs after explicit confirmation.
        rollbackButton = secondaryButton("Restore previous version");
        rollbackButton.setVisibility(View.GONE);
        rollbackButton.setOnClickListener(v -> {
            if (pendingRollback != null) {
                showRollbackDialog(pendingRollback);
            }
        });
        card.addView(rollbackButton);
        return card;
    }

    private View actionCard() {
        LinearLayout card = card();
        addCardTitle(card, "Launch A.G.");
        addHint(card, "Grant overlay and screen access, then start the orb.");

        overlayButton = primaryButton("Enable overlay permission");
        overlayButton.setOnClickListener(v -> openOverlaySettings());
        card.addView(overlayButton);

        accessibilityButton = primaryButton("Enable screen access");
        accessibilityButton.setOnClickListener(v -> openAccessibilitySettings());
        card.addView(accessibilityButton);

        mediaAccessButton = primaryButton("Enable media control");
        mediaAccessButton.setOnClickListener(v -> startActivity(
                MoaMediaNotificationListenerService.accessSettingsIntent()));
        card.addView(mediaAccessButton);

        appInfoButton = secondaryButton("Open A.G. app info");
        appInfoButton.setOnClickListener(v -> openAppInfoSettings());
        card.addView(appInfoButton);

        micButton = secondaryButton("Enable microphone");
        micButton.setOnClickListener(v -> requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO));
        card.addView(micButton);

        // Optional: lets the contact.open phone tool find and open a contact card.
        contactsButton = secondaryButton("Enable contacts access");
        contactsButton.setOnClickListener(v -> requestPermissions(new String[]{Manifest.permission.READ_CONTACTS}, REQUEST_CONTACTS));
        card.addView(contactsButton);

        startButton = primaryButton("Start assistant circle");
        startButton.setOnClickListener(v -> startOverlay());
        card.addView(startButton);

        stopButton = secondaryButton("Stop overlay");
        stopButton.setOnClickListener(v -> stopService(new Intent(this, OverlayService.class)));
        card.addView(stopButton);

        addPermissionHelp(card);
        return card;
    }

    // Collapsed by default: the permission troubleshooting prose lives behind a
    // tappable caption instead of three always-on paragraphs.
    private void addPermissionHelp(LinearLayout card) {
        TextView toggle = label("Help with permissions", MoaColors.GOLD, 13, true);
        toggle.setPadding(0, dp(14), 0, dp(4));
        card.addView(toggle);

        TextView detail = label(
                "Overlay draws the floating orb. Screen access reads the current screen for context and controlled actions. "
                        + "If Android blocks the toggle, open A.G. app info, tap the three-dot menu, allow restricted settings, then enable screen access. "
                        + "Microphone is asked directly; voice starts only after an orb gesture.",
                MoaColors.MUTED, 13, false);
        detail.setLineSpacing(dp(2), 1f);
        detail.setPadding(0, 0, 0, dp(4));
        detail.setVisibility(View.GONE);
        card.addView(detail);

        toggle.setOnClickListener(v -> {
            boolean show = detail.getVisibility() != View.VISIBLE;
            detail.setVisibility(show ? View.VISIBLE : View.GONE);
            toggle.setText(show ? "Hide help" : "Help with permissions");
        });
    }

    private View orbSizeCard() {
        LinearLayout card = card();

        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = label("Orb size", MoaColors.PAPER, 18, true);
        titleRow.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        int current = MoaPrefs.orbScalePercent(this);
        orbScaleValue = label(current + "%", MoaColors.GOLD, 15, true);
        titleRow.addView(orbScaleValue);
        card.addView(titleRow);

        SeekBar seekBar = new SeekBar(this);
        seekBar.setMax(MoaPrefs.ORB_SCALE_MAX - MoaPrefs.ORB_SCALE_MIN);
        seekBar.setProgress(current - MoaPrefs.ORB_SCALE_MIN);
        if (seekBar.getProgressDrawable() != null) {
            seekBar.getProgressDrawable().setColorFilter(MoaColors.GOLD, PorterDuff.Mode.SRC_IN);
        }
        if (seekBar.getThumb() != null) {
            seekBar.getThumb().setColorFilter(MoaColors.GOLD, PorterDuff.Mode.SRC_IN);
        }
        LinearLayout.LayoutParams seekParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        seekParams.topMargin = dp(8);
        seekBar.setLayoutParams(seekParams);
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (orbScaleValue != null) {
                    orbScaleValue.setText((MoaPrefs.ORB_SCALE_MIN + progress) + "%");
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                int percent = MoaPrefs.ORB_SCALE_MIN + bar.getProgress();
                MoaPrefs.setOrbScalePercent(MainActivity.this, percent);
                if (orbScaleValue != null) {
                    orbScaleValue.setText(percent + "%");
                }
                try {
                    startService(new Intent(MainActivity.this, OverlayService.class)
                            .setAction(ACTION_REFRESH_ORB_SCALE));
                } catch (Exception ignored) {
                }
            }
        });
        card.addView(seekBar);
        return card;
    }

    private View gesturesCard() {
        LinearLayout card = card();
        addCardTitle(card, "Gestures");

        CheckBox voiceFirst = new CheckBox(this);
        voiceFirst.setText("Manual voice orb controls");
        voiceFirst.setTextColor(MoaColors.PAPER);
        voiceFirst.setTextSize(15);
        voiceFirst.setChecked(MoaPrefs.voiceFirstGestures(this));
        voiceFirst.setPadding(0, dp(4), 0, dp(8));
        card.addView(voiceFirst);

        LinearLayout rows = new LinearLayout(this);
        rows.setOrientation(LinearLayout.VERTICAL);
        card.addView(rows);
        populateGestureRows(rows, MoaPrefs.voiceFirstGestures(this));

        // Persist immediately so the running overlay, which reads the flag live
        // per gesture, picks up the change with no reboot; then re-render the
        // legend to match the active contract.
        voiceFirst.setOnCheckedChangeListener((button, checked) -> {
            MoaPrefs.setVoiceFirstGestures(this, checked);
            populateGestureRows(rows, checked);
        });
        return card;
    }

    private void populateGestureRows(LinearLayout rows, boolean voiceFirst) {
        rows.removeAllViews();
        if (voiceFirst) {
            gestureRow(rows, "Tap", "Start or interrupt");
            gestureRow(rows, "Tap while listening", "Stop and send/store");
            gestureRow(rows, "Double-tap", "Toggle a new voice thread");
            gestureRow(rows, "Triple-tap", "Open chat");
            gestureRow(rows, "Press + hold", "Talk; release sends");
            gestureRow(rows, "Drag", "Move");
        } else {
            gestureRow(rows, "Tap", "Chat");
            gestureRow(rows, "Hold", "Move");
            gestureRow(rows, "Double-tap + hold", "Talk");
        }
    }

    private void gestureRow(LinearLayout parent, String action, String meaning) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(6), 0, dp(6));

        TextView dot = label("•", MoaColors.GOLD, 16, true);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dotParams.rightMargin = dp(10);
        dot.setLayoutParams(dotParams);
        row.addView(dot);

        TextView act = label(action, MoaColors.PAPER, 15, true);
        row.addView(act);

        TextView mean = label(meaning, MoaColors.MUTED, 15, false);
        mean.setGravity(Gravity.END);
        LinearLayout.LayoutParams meanParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        meanParams.leftMargin = dp(12);
        mean.setLayoutParams(meanParams);
        row.addView(mean);
        parent.addView(row);
    }

    private void updatePermissionState() {
        boolean overlayGranted = Settings.canDrawOverlays(this);
        boolean accessibilityGranted = MoaAccessibilityService.isEnabled(this);
        boolean mediaGranted = MoaMediaNotificationListenerService.isAccessEnabled(this);
        boolean micGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean contactsGranted = checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;

        if (overlayStatus != null) {
            overlayStatus.setText(overlayGranted ? "Ready" : "Needs draw-over-apps");
            overlayStatus.setTextColor(overlayGranted ? MoaColors.OK : MoaColors.WARN);
        }

        if (accessibilityStatus != null) {
            accessibilityStatus.setText(accessibilityGranted ? "Ready" : "Needs Screen access");
            accessibilityStatus.setTextColor(accessibilityGranted ? MoaColors.OK : MoaColors.WARN);
        }

        if (mediaStatus != null) {
            mediaStatus.setText(mediaGranted ? "Ready" : "Needs Notification access");
            mediaStatus.setTextColor(mediaGranted ? MoaColors.OK : MoaColors.WARN);
        }

        if (micStatus != null) {
            micStatus.setText(micGranted ? "Ready" : "Needs microphone");
            micStatus.setTextColor(micGranted ? MoaColors.OK : MoaColors.WARN);
        }

        if (requirementsSummary != null) {
            String summary = requirementsSummary(overlayGranted, accessibilityGranted, micGranted);
            requirementsSummary.setText(summary);
            requirementsSummary.setVisibility(summary.isEmpty() ? View.GONE : View.VISIBLE);
        }

        if (gatewayStatus != null) {
            String gatewayUrl = MoaPrefs.gatewayUrl(this);
            boolean configured = gatewayUrl != null && !gatewayUrl.trim().isEmpty();
            if (configured) {
                gatewayStatus.setText("Checking...");
                gatewayStatus.setTextColor(MoaColors.GOLD);
                checkGatewayHealth(gatewayUrl);
                checkForAppUpdate(false);
                refreshControlCenter();
                releaseController.refresh();
            } else {
                gatewayHealthGeneration++;
                updateCheckGeneration++;
                gatewayStatus.setText("Local fallback");
                gatewayStatus.setTextColor(MoaColors.GOLD);
                if (updateStatus != null) {
                    updateStatus.setText("Gateway required");
                    updateStatus.setTextColor(MoaColors.GOLD);
                }
                setControlCenterGatewayRequired();
                releaseController.unavailable("Gateway required. Current app behavior is unchanged.");
            }
        }

        if (overlayButton != null) {
            overlayButton.setVisibility(overlayGranted ? View.GONE : View.VISIBLE);
        }

        if (accessibilityButton != null) {
            accessibilityButton.setVisibility(accessibilityGranted ? View.GONE : View.VISIBLE);
        }

        if (mediaAccessButton != null) {
            mediaAccessButton.setVisibility(mediaGranted ? View.GONE : View.VISIBLE);
        }

        if (appInfoButton != null) {
            appInfoButton.setVisibility(accessibilityGranted ? View.GONE : View.VISIBLE);
        }

        if (micButton != null) {
            micButton.setVisibility(micGranted ? View.GONE : View.VISIBLE);
        }

        if (contactsButton != null) {
            contactsButton.setVisibility(contactsGranted ? View.GONE : View.VISIBLE);
        }

        if (startButton != null) {
            startButton.setEnabled(overlayGranted);
            startButton.setAlpha(overlayGranted ? 1f : 0.45f);
        }

        if (updateButton != null && pendingUpdate != null) {
            updateButton.setText("Review app update");
        }
    }

    private void openOverlaySettings() {
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName())
        );
        startActivity(intent);
    }

    private void openAccessibilitySettings() {
        startActivity(MoaAccessibilityService.settingsIntent());
    }

    private void openAppInfoSettings() {
        Intent intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName())
        );
        startActivity(intent);
    }

    private void maybeRequestMicPermission() {
        if (requestedMicOnStartup) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestedMicOnStartup = true;
        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO);
    }

    private void startOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            openOverlaySettings();
            return;
        }
        Intent intent = new Intent(this, OverlayService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void collapseOverlaySurfaces() {
        Intent intent = new Intent(this, OverlayService.class);
        intent.setAction(OverlayService.ACTION_COLLAPSE_SURFACES);
        startService(intent);
    }

    private void applyIntentConfiguration(Intent intent) {
        if (intent == null) {
            return;
        }
        if (intent.getBooleanExtra(EXTRA_REVIEW_UPDATE, false)) {
            reviewUpdateOnNextCheck = true;
            intent.removeExtra(EXTRA_REVIEW_UPDATE);
        }
        boolean hasGatewayUrl = intent.hasExtra(EXTRA_GATEWAY_URL);
        boolean hasGatewayToken = intent.hasExtra(EXTRA_GATEWAY_TOKEN);
        if (!hasGatewayUrl && !hasGatewayToken) {
            return;
        }
        MoaPrefs.saveGatewayConfig(
                this,
                hasGatewayUrl ? intent.getStringExtra(EXTRA_GATEWAY_URL) : MoaPrefs.gatewayUrl(this),
                hasGatewayToken ? intent.getStringExtra(EXTRA_GATEWAY_TOKEN) : MoaPrefs.gatewayToken(this)
        );
    }

    private void saveGatewaySettings() {
        MoaPrefs.saveGatewayConfig(
                this,
                gatewayUrlInput.getText().toString(),
                gatewayTokenInput.getText().toString()
        );
        if (spokenRepliesInput != null) {
            MoaPrefs.setSpokenRepliesEnabled(this, spokenRepliesInput.isChecked());
        }
        if (preferredYoutubeInput != null) {
            MoaPrefs.setPreferredYoutubePackage(this, preferredYoutubeInput.getText().toString());
            preferredYoutubeInput.setText(MoaPrefs.preferredYoutubePackage(this));
            capturePreferredYoutubeFixture();
        }
        updatePermissionState();
    }

    private void capturePreferredYoutubeFixture() {
        String packageName = MoaPrefs.preferredYoutubePackage(this);
        try {
            PackageInfo info = getPackageManager().getPackageInfo(packageName, signatureFlags());
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode() : info.versionCode;
            String signer = String.join(",", new TreeSet<>(signatureDigests(info)));
            MoaPrefs.saveYoutubePackageFixture(this, packageName, versionCode, signer);
        } catch (Exception unavailable) {
            MoaPrefs.clearYoutubePackageFixture(this);
        }
    }

    private String settingsSummaryText() {
        String speech = MoaPrefs.spokenRepliesEnabled(this) ? "Spoken replies on" : "Text replies";
        return speech + " / " + MoaPrefs.languageStatus(this);
    }

    private String androidDeviceId() {
        String raw = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        String safe = raw == null ? "" : raw.replaceAll("[^a-zA-Z0-9_-]", "");
        if (safe.isEmpty()) {
            safe = "unknown";
        }
        return "android_" + safe;
    }

    private String installedReleaseLabel() {
        try {
            return "v" + currentVersionName() + " · code " + currentVersionCode()
                    + " · " + BuildConfig.GIT_SHA;
        } catch (Exception ignored) {
            return "Installed locally";
        }
    }

    private MoaReleaseCardController createReleaseController() {
        return new MoaReleaseCardController(this, new MoaReleaseCardController.Host() {
            @Override public String gatewayUrl() {
                return MoaPrefs.gatewayUrl(MainActivity.this);
            }

            @Override public String gatewayToken() {
                return MoaPrefs.gatewayToken(MainActivity.this);
            }

            @Override public String deviceId() {
                return androidDeviceId();
            }

            @Override public String installedLabel() {
                return installedReleaseLabel();
            }

            @Override public long installedVersionCode() throws Exception {
                return currentVersionCode();
            }

            @Override public String installedVersionName() throws Exception {
                return currentVersionName();
            }

            @Override public String installedArtifactSha256() throws Exception {
                return sha256Hex(new File(getApplicationInfo().sourceDir));
            }

            @Override public void reviewInstall(
                    MoaReleaseSelectionPolicy.Candidate candidate,
                    String gatewayUrl,
                    String gatewayToken) {
                reviewSelectedReleaseInstall(candidate, gatewayUrl, gatewayToken);
            }
        });
    }

    private void reviewSelectedReleaseInstall(
            MoaReleaseSelectionPolicy.Candidate candidate,
            String gatewayUrl,
            String gatewayToken) {
        if (candidate == null || !candidate.installable()) return;
        try {
            long installedCode = currentVersionCode();
            if (candidate.artifact.versionCode < installedCode) {
                new AlertDialog.Builder(this)
                        .setTitle("A recovery build is required")
                        .setMessage("Android cannot safely install this older release over the current app. "
                                + "A.G. will not uninstall itself because that could remove local settings "
                                + "and strand recovery. Ask for a signed, forward-moving stable recovery build.")
                        .setPositiveButton("OK", null)
                        .show();
                return;
            }
        } catch (Exception ignored) {
            releaseController.showInstallStatus(
                    "Installed version could not be verified. Nothing was downloaded.", MoaColors.WARN);
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Review release install")
                .setMessage("A.G. will download and verify " + candidate.label()
                        + ". Android will then ask you to confirm installation. "
                        + "Selecting this release did not install it.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Download", (ignored, which) ->
                        installSelectedRelease(candidate, gatewayUrl, gatewayToken))
                .show();
    }

    private void installSelectedRelease(
            MoaReleaseSelectionPolicy.Candidate candidate,
            String gatewayUrl,
            String gatewayToken) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            startActivity(new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())));
            releaseController.showInstallStatus(
                    "Allow installs, then tap Download and review install again.", MoaColors.GOLD);
            return;
        }
        releaseController.setInstallBusy(true);
        releaseController.showInstallStatus("Downloading selected release...", MoaColors.GOLD);
        final int installGeneration = ++releaseInstallGeneration;
        new Thread(() -> {
            try {
                File apk = updateApkFile();
                MoaReleaseControlClient client = new MoaReleaseControlClient(
                        gatewayUrl, gatewayToken);
                client.downloadArtifact(
                        candidate.artifact.downloadUrl, candidate.artifact.sizeBytes, apk);
                long installedCode = currentVersionCode();
                if (candidate.artifact.versionCode > installedCode) {
                    verifyDownloadedUpdate(candidate.artifact.asUpdateManifest(), apk);
                } else {
                    verifyDownloadedRollback(new MoaUpdatePolicy.RollbackOption(
                            candidate.releaseId,
                            candidate.artifact.versionCode,
                            candidate.artifact.versionName,
                            candidate.artifact.downloadUrl,
                            candidate.artifact.sha256,
                            candidate.artifact.sizeBytes,
                            false), apk);
                }
                releaseController.postInstallReceiptBestEffort(candidate, "download_verified", "");
                mainHandler.post(() -> {
                    if (isFinishing() || installGeneration != releaseInstallGeneration) return;
                    boolean opened = launchInstaller();
                    new Thread(() -> releaseController.postInstallReceiptBestEffort(
                            candidate,
                            opened ? "installer_opened" : "failed",
                            opened ? "" : "installer_unavailable"), "moa-release-install-receipt").start();
                    releaseController.showInstallStatus(opened
                            ? "Installer opened. Android still requires your confirmation."
                            : "Android's installer could not be opened. Nothing was installed.",
                            opened ? MoaColors.OK : MoaColors.WARN);
                });
            } catch (Exception error) {
                releaseController.postInstallReceiptBestEffort(
                        candidate, "failed", "verification_or_download_failed");
                mainHandler.post(() -> {
                    if (isFinishing() || installGeneration != releaseInstallGeneration) return;
                    releaseController.showInstallStatus(
                            "Release download or verification failed. Nothing was installed.",
                            MoaColors.WARN);
                });
            } finally {
                mainHandler.post(() -> {
                    if (!isFinishing() && installGeneration == releaseInstallGeneration) {
                        releaseController.setInstallBusy(false);
                    }
                });
            }
        }, "moa-release-install").start();
    }

    private void refreshControlCenter() {
        if (sessionsStatus == null || runsStatus == null || receiptsStatus == null) {
            return;
        }

        receiptsStatus.setText(MoaActionReceiptStore.receipts(this).length() + " local");
        receiptsStatus.setTextColor(MoaColors.OK);
        if (settingsStatus != null) {
            settingsStatus.setText(settingsSummaryText());
        }
        if (companionStatus != null) {
            companionStatus.setText(MoaPrefs.companionStatus(this));
            companionStatus.setTextColor(MoaColors.OK);
        }
        if (voiceE2eStatus != null) {
            voiceE2eStatus.setText(MoaVoiceE2eMetricsStore.summary(this));
            voiceE2eStatus.setTextColor(MoaColors.OK);
        }

        String gatewayUrl = MoaPrefs.gatewayUrl(this);
        if (gatewayUrl == null || gatewayUrl.trim().isEmpty()) {
            setControlCenterGatewayRequired();
            return;
        }

        sessionsStatus.setText("Checking...");
        runsStatus.setText("Checking...");
        sessionsStatus.setTextColor(MoaColors.GOLD);
        runsStatus.setTextColor(MoaColors.GOLD);
        if (sessionHistoryStatus != null) {
            sessionHistoryStatus.setText("Loading shared history...");
            sessionHistoryStatus.setTextColor(MoaColors.GOLD);
        }
        if (companionStatus != null) {
            companionStatus.setText("Checking...");
            companionStatus.setTextColor(MoaColors.GOLD);
        }

        final int generation = ++controlCenterGeneration;
        new Thread(() -> {
            String sharedSessionId = MoaPrefs.conversationId(this);
            String sessionsLabel = sharedSessionId;
            String runsLabel = "Unavailable";
            MoaSessionHistory fetchedHistory = null;
            String historyError = "";
            String fetchedProfileJson = "";
            String fetchedCompanionJson = "";
            int sessionsColor = MoaColors.GOLD;
            int runsColor = MoaColors.GOLD;
            int companionColor = MoaColors.GOLD;
            MoaGatewayClient client = new MoaGatewayClient(gatewayUrl, MoaPrefs.gatewayToken(this));
            try {
                String canonicalSessionId = client.defaultSessionId();
                if (canonicalSessionId != null && !canonicalSessionId.trim().isEmpty()) {
                    sharedSessionId = canonicalSessionId.trim();
                    sessionsLabel = sharedSessionId;
                }
            } catch (Exception ignored) {
                // Older gateways may not expose the shared-session route. The
                // device's stable conversation id remains a valid fallback.
            }
            try {
                JSONObject historyPayload = client.sessionMessages(sharedSessionId, MoaSessionHistory.MAX_MESSAGES);
                fetchedHistory = MoaSessionHistory.from(historyPayload, sharedSessionId);
                if (!fetchedHistory.sessionId.isEmpty()) {
                    sharedSessionId = fetchedHistory.sessionId;
                    sessionsLabel = sharedSessionId;
                }
                sessionsColor = MoaColors.OK;
            } catch (Exception ignored) {
                historyError = "History unavailable. Tap Refresh to retry.";
            }
            try {
                JSONObject context = client.latestContext();
                JSONArray runs = context.optJSONArray("recent_runs");
                int activeRuns = 0;
                if (runs != null) {
                    for (int i = 0; i < runs.length(); i++) {
                        JSONObject run = runs.optJSONObject(i);
                        if (run != null && run.optBoolean("active", false)) {
                            activeRuns++;
                        }
                    }
                }
                int runCount = runs == null ? 0 : runs.length();
                runsLabel = activeRuns > 0 ? activeRuns + " active / " + runCount + " recent" : runCount + " recent";
                runsColor = MoaColors.OK;
            } catch (Exception ignored) {
            }
            try {
                JSONObject profilePayload = client.agentProfile("device", androidDeviceId());
                JSONObject profile = profilePayload.optJSONObject("profile");
                if (profile != null) {
                    fetchedProfileJson = profile.toString();
                }
            } catch (Exception ignored) {
            }
            try {
                JSONObject companion = client.activeCompanionPet("device", androidDeviceId());
                if (companion != null && companion.length() > 0) {
                    fetchedCompanionJson = companion.toString();
                    companionColor = MoaColors.OK;
                }
            } catch (Exception ignored) {
            }

            final String nextSharedSessionId = sharedSessionId;
            final String nextSessions = sessionsLabel;
            final String nextRuns = runsLabel;
            final MoaSessionHistory nextHistory = fetchedHistory;
            final String nextHistoryError = historyError;
            final String nextProfileJson = fetchedProfileJson;
            final String nextCompanionJson = fetchedCompanionJson;
            final int nextSessionsColor = sessionsColor;
            final int nextRunsColor = runsColor;
            final int nextCompanionColor = companionColor;
            mainHandler.post(() -> {
                if (generation != controlCenterGeneration) {
                    return;
                }
                if (!nextSharedSessionId.isEmpty()) {
                    MoaPrefs.setConversationId(this, nextSharedSessionId);
                }
                if (!nextProfileJson.isEmpty()) {
                    MoaPrefs.setAgentProfileJson(this, nextProfileJson);
                }
                if (!nextCompanionJson.isEmpty()) {
                    MoaPrefs.setActiveCompanionJson(this, nextCompanionJson);
                }
                if (sessionsStatus != null) {
                    sessionsStatus.setText(nextSessions);
                    sessionsStatus.setTextColor(nextSessionsColor);
                }
                if (runsStatus != null) {
                    runsStatus.setText(nextRuns);
                    runsStatus.setTextColor(nextRunsColor);
                }
                renderSessionHistory(nextHistory, nextHistoryError);
                if (settingsStatus != null) {
                    settingsStatus.setText(settingsSummaryText());
                }
                if (companionStatus != null) {
                    companionStatus.setText(MoaPrefs.companionStatus(this));
                    companionStatus.setTextColor(nextCompanionJson.isEmpty() ? MoaColors.GOLD : nextCompanionColor);
                }
            });
        }, "moa-control-center").start();
    }

    private void setControlCenterGatewayRequired() {
        controlCenterGeneration++;
        if (sessionsStatus != null) {
            sessionsStatus.setText("Gateway required");
            sessionsStatus.setTextColor(MoaColors.GOLD);
        }
        if (runsStatus != null) {
            runsStatus.setText("Gateway required");
            runsStatus.setTextColor(MoaColors.GOLD);
        }
        if (receiptsStatus != null) {
            receiptsStatus.setText(MoaActionReceiptStore.receipts(this).length() + " local");
            receiptsStatus.setTextColor(MoaColors.OK);
        }
        if (settingsStatus != null) {
            settingsStatus.setText(settingsSummaryText());
        }
        if (companionStatus != null) {
            companionStatus.setText(MoaPrefs.companionStatus(this));
            companionStatus.setTextColor(MoaColors.GOLD);
        }
        renderSessionHistory(null, "Connect the gateway to load shared history.");
    }

    private void renderSessionHistory(MoaSessionHistory history, String statusMessage) {
        if (sessionHistoryColumn == null || sessionHistoryStatus == null) {
            return;
        }
        String error = statusMessage == null ? "" : statusMessage.trim();
        if (history == null) {
            sessionHistoryStatus.setText(error.isEmpty() ? "Shared history unavailable" : error);
            sessionHistoryStatus.setTextColor(error.isEmpty() ? MoaColors.MUTED : MoaColors.WARN);
            if (sessionHistoryColumn.getChildCount() == 0) {
                sessionHistoryColumn.addView(historyPlaceholder("No shared messages loaded."));
            }
            return;
        }

        sessionHistoryColumn.removeAllViews();
        if (history.turns.isEmpty()) {
            sessionHistoryStatus.setText("Recent shared history");
            sessionHistoryStatus.setTextColor(MoaColors.MUTED);
            sessionHistoryColumn.addView(historyPlaceholder("No saved messages in this session yet."));
            return;
        }

        sessionHistoryStatus.setText(history.turns.size() == 1
                ? "1 recent shared turn" : history.turns.size() + " recent shared turns");
        sessionHistoryStatus.setTextColor(MoaColors.OK);
        for (MoaSessionHistory.Turn turn : history.turns) {
            sessionHistoryColumn.addView(historyTurnView(turn));
        }
    }

    private View historyTurnView(MoaSessionHistory.Turn turn) {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setTag(turn.stableId);
        container.setPadding(dp(10), dp(10), dp(10), dp(12));
        container.setBackground(MoaDrawables.rounded(
                MoaColors.RAISED, dp(12), MoaColors.RAISED_BORDER, dp(1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        container.setLayoutParams(params);

        TextView metadata = label(turn.metadataLine(), MoaColors.MUTED, 11, false);
        metadata.setLineSpacing(dp(1), 1f);
        container.addView(metadata);
        if (!turn.userText.isEmpty()) {
            container.addView(historySpeakerText("YOU", turn.userText, 0xFFBFA9FF));
        }
        if (!turn.assistantText.isEmpty()) {
            container.addView(historySpeakerText("A.G.", turn.assistantText, MoaColors.GOLD));
        } else {
            TextView unavailable = label("No retained assistant text.", MoaColors.MUTED, 13, false);
            unavailable.setPadding(0, dp(8), 0, 0);
            container.addView(unavailable);
        }
        return container;
    }

    private View historySpeakerText(String speaker, String content, int speakerColor) {
        LinearLayout block = new LinearLayout(this);
        block.setOrientation(LinearLayout.VERTICAL);
        block.setPadding(0, dp(10), 0, 0);
        TextView speakerLabel = label(speaker, speakerColor, 10, true);
        speakerLabel.setLetterSpacing(0.08f);
        block.addView(speakerLabel);
        TextView body = label(content, MoaColors.PAPER, 14, false);
        body.setLineSpacing(dp(3), 1f);
        body.setPadding(0, dp(3), 0, 0);
        body.setTextIsSelectable(true);
        body.setContentDescription(speaker + " message");
        block.addView(body);
        return block;
    }

    private TextView historyPlaceholder(String message) {
        TextView placeholder = label(message, MoaColors.MUTED, 13, false);
        placeholder.setGravity(Gravity.CENTER);
        placeholder.setPadding(dp(8), dp(24), dp(8), dp(24));
        return placeholder;
    }

    private void checkGatewayHealth(String gatewayUrl) {
        final int generation = ++gatewayHealthGeneration;
        final MoaPrefs.GatewayUrlIssue urlIssue = MoaPrefs.classifyGatewayUrl(gatewayUrl);
        if (urlIssue == MoaPrefs.GatewayUrlIssue.MISSING_SCHEME
                || urlIssue == MoaPrefs.GatewayUrlIssue.ENDPOINT_PATH) {
            if (gatewayStatus != null) {
                gatewayStatus.setText(urlIssue == MoaPrefs.GatewayUrlIssue.MISSING_SCHEME
                        ? "URL needs http(s)://"
                        : "Save origin, not endpoint");
                gatewayStatus.setTextColor(MoaColors.WARN);
            }
            return;
        }
        if (gatewayStatus != null && urlIssue == MoaPrefs.GatewayUrlIssue.STALE_MAIN_MACHINE) {
            gatewayStatus.setText("Checking old ZeroTier URL...");
            gatewayStatus.setTextColor(MoaColors.WARN);
        } else if (gatewayStatus != null && urlIssue == MoaPrefs.GatewayUrlIssue.LOCAL_DEV) {
            gatewayStatus.setText("Checking local dev URL...");
            gatewayStatus.setTextColor(MoaColors.WARN);
        }
        final String healthUrl = gatewayEndpoint(gatewayUrl, "/health");
        final String authProbeUrl = gatewayEndpoint(gatewayUrl, "/v1/sessions?limit=1");
        final String gatewayToken = MoaPrefs.gatewayToken(this);

        new Thread(() -> {
            boolean reachable = false;
            String label = "Unreachable";
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(healthUrl).openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(2500);
                connection.setReadTimeout(2500);
                int code = connection.getResponseCode();
                reachable = code >= 200 && code < 300;
                label = reachable ? "Reachable" : "HTTP " + code;
            } catch (Exception ignored) {
                label = "Unreachable";
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }

            boolean tokenProblem = false;
            if (reachable) {
                // /health never requires auth, so a green "Reachable" alone can
                // hide a bad token. Probe one protected route to split "wrong
                // URL" from "reachable but token rejected" before the first turn.
                int authCode = gatewayStatusCode(authProbeUrl, gatewayToken);
                if (authCode >= 200 && authCode < 300) {
                    label = "Reachable / token OK";
                } else if (authCode == 401 || authCode == 403) {
                    tokenProblem = true;
                    label = gatewayToken.isEmpty() ? "Token required" : "Token rejected";
                }
            }
            if (urlIssue == MoaPrefs.GatewayUrlIssue.STALE_MAIN_MACHINE) {
                label = label + " / old ZeroTier URL";
            } else if (urlIssue == MoaPrefs.GatewayUrlIssue.LOCAL_DEV) {
                label = label + " / local dev URL";
            }

            final boolean isReachable = reachable;
            final boolean isTokenProblem = tokenProblem;
            final String status = label;
            mainHandler.post(() -> {
                if (generation != gatewayHealthGeneration || gatewayStatus == null) {
                    return;
                }
                gatewayStatus.setText(status);
                gatewayStatus.setTextColor(isReachable && !isTokenProblem ? MoaColors.OK : MoaColors.WARN);
            });
        }, "moa-gateway-health").start();
    }

    private static int gatewayStatusCode(String url, String bearerToken) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(2500);
            connection.setReadTimeout(2500);
            if (bearerToken != null && !bearerToken.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
            }
            return connection.getResponseCode();
        } catch (Exception ignored) {
            return -1;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void checkForAppUpdate(boolean userInitiated) {
        final int generation = ++updateCheckGeneration;
        final String gatewayUrl = MoaPrefs.gatewayUrl(this);
        if (gatewayUrl == null || gatewayUrl.trim().isEmpty()) {
            return;
        }
        if (updateStatus != null) {
            updateStatus.setText("Checking...");
            updateStatus.setTextColor(MoaColors.GOLD);
        }
        if (updateButton != null) {
            updateButton.setEnabled(false);
            updateButton.setAlpha(0.6f);
        }

        new Thread(() -> {
            String label = "Unavailable";
            int color = MoaColors.GOLD;
            JSONObject update = null;
            MoaUpdatePolicy.Decision decision = null;
            try {
                MoaGatewayClient client = new MoaGatewayClient(gatewayUrl, MoaPrefs.gatewayToken(this));
                JSONObject manifest = client.latestAndroidUpdate();
                decision = MoaUpdatePolicy.evaluate(
                        manifest,
                        currentVersionCode(),
                        BuildConfig.GIT_SHA,
                        MoaPrefs.deferredUpdateVersionCode(this)
                );
                if (decision.isAvailable()) {
                    update = manifest;
                    label = "v" + decision.versionName
                            + (decision.state == MoaUpdatePolicy.State.DEFERRED ? " — later" : " available");
                    color = MoaColors.OK;
                } else if (decision.state == MoaUpdatePolicy.State.INVALID) {
                    label = "Update metadata rejected";
                    color = MoaColors.WARN;
                } else {
                    label = "Current";
                    color = MoaColors.OK;
                }
            } catch (Exception ignored) {
                if (!userInitiated) {
                    label = "Unavailable";
                }
            }

            final JSONObject nextUpdate = update;
            final MoaUpdatePolicy.Decision nextDecision = decision;
            final String nextLabel = label;
            final int nextColor = color;
            mainHandler.post(() -> {
                if (generation != updateCheckGeneration) {
                    return;
                }
                pendingUpdate = nextUpdate;
                pendingRollback = nextDecision != null ? nextDecision.rollback : null;
                updateRollbackButton();
                if (updateStatus != null) {
                    updateStatus.setText(nextLabel);
                    updateStatus.setTextColor(nextColor);
                }
                if (updateButton != null) {
                    updateButton.setEnabled(true);
                    updateButton.setAlpha(1f);
                    updateButton.setText(nextUpdate == null ? "Check for app update" : "Review app update");
                    updateButton.setOnClickListener(v -> {
                        if (pendingUpdate == null) {
                            checkForAppUpdate(true);
                        } else {
                            showUpdateDecisionDialog(pendingUpdate);
                        }
                    });
                }
                boolean forcedReview = reviewUpdateOnNextCheck;
                reviewUpdateOnNextCheck = false;
                if (nextUpdate != null && nextDecision != null
                        && (userInitiated || forcedReview || nextDecision.state == MoaUpdatePolicy.State.AVAILABLE)) {
                    showUpdateDecisionDialog(nextUpdate);
                }
            });
        }, "moa-update-check").start();
    }

    private void showUpdateDecisionDialog(JSONObject update) {
        if (update == null || isFinishing()) {
            return;
        }
        MoaUpdatePolicy.Decision decision;
        try {
            decision = MoaUpdatePolicy.evaluate(
                    update,
                    currentVersionCode(),
                    BuildConfig.GIT_SHA,
                    MoaPrefs.deferredUpdateVersionCode(this)
            );
        } catch (Exception error) {
            return;
        }
        if (!decision.isAvailable() || updateDialogVersionCode == decision.versionCode) {
            return;
        }
        updateDialogVersionCode = decision.versionCode;
        MoaPrefs.markUpdateNotified(this, decision.versionCode);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("New A.G. version available")
                .setMessage(MoaUpdatePolicy.decisionMessage(decision))
                .setNegativeButton("Not now", (ignored, which) -> {
                    MoaPrefs.deferUpdate(this, decision.versionCode);
                    updateDialogVersionCode = 0L;
                    if (updateStatus != null) {
                        updateStatus.setText("v" + decision.versionName + " — later");
                    }
                })
                .setPositiveButton("Install", (ignored, which) -> {
                    MoaPrefs.clearDeferredUpdate(this);
                    updateDialogVersionCode = 0L;
                    installPendingUpdate();
                })
                .create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnCancelListener(ignored -> {
            MoaPrefs.deferUpdate(this, decision.versionCode);
            updateDialogVersionCode = 0L;
        });
        dialog.setOnDismissListener(ignored -> updateDialogVersionCode = 0L);
        dialog.show();
    }

    private void installPendingUpdate() {
        JSONObject update = pendingUpdate;
        if (update == null) {
            checkForAppUpdate(true);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            if (updateStatus != null) {
                updateStatus.setText("Allow installs");
                updateStatus.setTextColor(MoaColors.GOLD);
            }
            startActivity(new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
            ));
            return;
        }

        if (updateStatus != null) {
            updateStatus.setText("Downloading...");
            updateStatus.setTextColor(MoaColors.GOLD);
        }
        if (updateButton != null) {
            updateButton.setEnabled(false);
            updateButton.setAlpha(0.6f);
        }

        new Thread(() -> {
            try {
                File apk = updateApkFile();
                MoaGatewayClient client = new MoaGatewayClient(MoaPrefs.gatewayUrl(this), MoaPrefs.gatewayToken(this));
                client.downloadLatestAndroidUpdate(apk);
                verifyDownloadedUpdate(update, apk);
                MoaPrefs.recordVersionBeforeUpdate(
                        this,
                        currentVersionCode(),
                        currentVersionName(),
                        BuildConfig.GIT_SHA
                );
                mainHandler.post(() -> launchInstaller());
                return;
            } catch (Exception ignored) {
                // Report a compact user-facing state below.
            }

            mainHandler.post(() -> {
                if (updateStatus != null) {
                    updateStatus.setText("Install failed");
                    updateStatus.setTextColor(MoaColors.GOLD);
                }
                if (updateButton != null) {
                    updateButton.setEnabled(true);
                    updateButton.setAlpha(1f);
                }
            });
        }, "moa-update-download").start();
    }

    private void updateRollbackButton() {
        if (rollbackButton == null) {
            return;
        }
        MoaUpdatePolicy.RollbackOption rollback = pendingRollback;
        if (rollback == null) {
            rollbackButton.setVisibility(View.GONE);
            return;
        }
        rollbackButton.setVisibility(View.VISIBLE);
        rollbackButton.setEnabled(true);
        rollbackButton.setAlpha(1f);
        rollbackButton.setText("Restore previous version (" + rollback.versionName + ")");
    }

    private void showRollbackDialog(MoaUpdatePolicy.RollbackOption rollback) {
        if (rollback == null || isFinishing()) {
            return;
        }
        String positive = rollback.requiresReinstall ? "Uninstall current" : "Restore";
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Restore previous version")
                .setMessage(MoaUpdatePolicy.rollbackMessage(rollback))
                .setNegativeButton("Not now", null)
                .setPositiveButton(positive, (ignored, which) -> {
                    if (rollback.requiresReinstall) {
                        routeToUninstallForRollback(rollback);
                    } else {
                        installRollback(rollback);
                    }
                })
                .create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.show();
    }

    // requires_reinstall: Android will not install an older version_code in
    // place, so the user must remove the current build first. We only send them
    // to the system uninstall screen; nothing is removed without their action.
    private void routeToUninstallForRollback(MoaUpdatePolicy.RollbackOption rollback) {
        if (updateStatus != null) {
            updateStatus.setText("Uninstall to restore v" + rollback.versionName);
            updateStatus.setTextColor(MoaColors.GOLD);
        }
        Intent uninstall = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(uninstall);
        } catch (ActivityNotFoundException error) {
            // Uninstall also lives on the app details screen on some devices.
            startActivity(new Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName())
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }

    // Non-reinstall rollback: the artifact is installable in place, so run the
    // same consent-first download + verify + system-installer path as an update.
    private void installRollback(MoaUpdatePolicy.RollbackOption rollback) {
        if (rollback == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            if (updateStatus != null) {
                updateStatus.setText("Allow installs");
                updateStatus.setTextColor(MoaColors.GOLD);
            }
            startActivity(new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
            ));
            return;
        }

        if (updateStatus != null) {
            updateStatus.setText("Downloading...");
            updateStatus.setTextColor(MoaColors.GOLD);
        }
        if (rollbackButton != null) {
            rollbackButton.setEnabled(false);
            rollbackButton.setAlpha(0.6f);
        }

        new Thread(() -> {
            try {
                File apk = updateApkFile();
                MoaGatewayClient client = new MoaGatewayClient(MoaPrefs.gatewayUrl(this), MoaPrefs.gatewayToken(this));
                client.downloadRollbackApk(rollback.downloadUrl, apk);
                verifyDownloadedRollback(rollback, apk);
                mainHandler.post(this::launchInstaller);
                return;
            } catch (Exception ignored) {
                // Report a compact user-facing state below.
            }

            mainHandler.post(() -> {
                if (updateStatus != null) {
                    updateStatus.setText("Restore failed");
                    updateStatus.setTextColor(MoaColors.GOLD);
                }
                if (rollbackButton != null) {
                    rollbackButton.setEnabled(true);
                    rollbackButton.setAlpha(1f);
                }
            });
        }, "moa-rollback-download").start();
    }

    private boolean launchInstaller() {
        Uri apkUri = Uri.parse("content://" + getPackageName() + ".apkprovider/ota/" + MoaApkProvider.APK_NAME);
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(apkUri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(install);
            if (updateStatus != null) {
                updateStatus.setText("Installer opened");
                updateStatus.setTextColor(MoaColors.OK);
            }
            return true;
        } catch (ActivityNotFoundException error) {
            if (updateStatus != null) {
                updateStatus.setText("No installer");
                updateStatus.setTextColor(MoaColors.GOLD);
            }
            return false;
        } finally {
            if (updateButton != null) {
                updateButton.setEnabled(true);
                updateButton.setAlpha(1f);
            }
            if (rollbackButton != null) {
                rollbackButton.setEnabled(true);
                rollbackButton.setAlpha(1f);
            }
        }
    }

    // Rollback verification mirrors verifyDownloadedUpdate but must not require a
    // higher version than installed — a rollback is intentionally same-or-lower.
    private void verifyDownloadedRollback(MoaUpdatePolicy.RollbackOption rollback, File apk) throws Exception {
        if (rollback.sizeBytes <= 0 || apk.length() != rollback.sizeBytes) {
            throw new IllegalStateException("rollback APK size mismatch");
        }
        if (!rollback.sha256.matches("[a-f0-9]{64}") || !rollback.sha256.equalsIgnoreCase(sha256Hex(apk))) {
            throw new IllegalStateException("rollback APK checksum mismatch");
        }

        PackageInfo archive = packageInfoForArchive(apk);
        if (archive == null || !getPackageName().equals(archive.packageName)) {
            throw new IllegalStateException("rollback APK package mismatch");
        }
        long archiveVersionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? archive.getLongVersionCode()
                : archive.versionCode;
        if (archiveVersionCode != rollback.versionCode) {
            throw new IllegalStateException("rollback APK version mismatch");
        }

        PackageInfo installed = getPackageManager().getPackageInfo(
                getPackageName(),
                signatureFlags()
        );
        if (!signatureDigests(installed).equals(signatureDigests(archive))) {
            throw new IllegalStateException("rollback APK signer mismatch");
        }
    }

    private void verifyDownloadedUpdate(JSONObject update, File apk) throws Exception {
        if (!getPackageName().equals(update.optString("app_id", "").trim())) {
            throw new IllegalStateException("APK application id mismatch");
        }
        long expectedSize = update.optLong("size_bytes", 0);
        if (expectedSize <= 0 || apk.length() != expectedSize) {
            throw new IllegalStateException("APK size mismatch");
        }
        String expectedSha = update.optString("sha256", "").trim().toLowerCase();
        if (!expectedSha.matches("[a-f0-9]{64}") || !expectedSha.equalsIgnoreCase(sha256Hex(apk))) {
            throw new IllegalStateException("APK checksum mismatch");
        }

        PackageInfo archive = packageInfoForArchive(apk);
        if (archive == null || !getPackageName().equals(archive.packageName)) {
            throw new IllegalStateException("APK package mismatch");
        }
        long archiveVersionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? archive.getLongVersionCode()
                : archive.versionCode;
        long manifestVersionCode = update.optLong("version_code", 0L);
        if (manifestVersionCode <= currentVersionCode() || archiveVersionCode != manifestVersionCode) {
            throw new IllegalStateException("APK version mismatch");
        }

        PackageInfo installed = getPackageManager().getPackageInfo(
                getPackageName(),
                signatureFlags()
        );
        if (!signatureDigests(installed).equals(signatureDigests(archive))) {
            throw new IllegalStateException("APK signer mismatch");
        }
    }

    private PackageInfo packageInfoForArchive(File apk) {
        return getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), signatureFlags());
    }

    private int signatureFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
    }

    private Set<String> signatureDigests(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            signatures = info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) {
            throw new IllegalStateException("APK signer missing");
        }
        Set<String> digests = new HashSet<>();
        for (Signature signature : signatures) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(signature.toByteArray());
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) {
                hex.append(String.format("%02x", value));
            }
            digests.add(hex.toString());
        }
        return digests;
    }

    private File updateApkFile() {
        File dir = new File(getCacheDir(), "updates");
        dir.mkdirs();
        return new File(dir, MoaApkProvider.APK_NAME);
    }

    private long currentVersionCode() throws Exception {
        PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.getLongVersionCode();
        }
        return info.versionCode;
    }

    private String currentVersionName() throws Exception {
        PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
        return info.versionName == null ? "" : info.versionName;
    }

    private String sha256Hex(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32 * 1024];
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(buffer)) >= 0) {
                digest.update(buffer, 0, read);
            }
        }
        byte[] bytes = digest.digest();
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            hex.append(String.format("%02x", value & 0xff));
        }
        return hex.toString();
    }

    private String gatewayEndpoint(String gatewayUrl, String path) {
        String base = gatewayUrl == null ? "" : gatewayUrl.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + path;
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(MoaDrawables.rounded(MoaColors.RAISED, dp(20), MoaColors.RAISED_BORDER, dp(1)));
        card.setElevation(dp(6));

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dp(14);
        card.setLayoutParams(params);
        return card;
    }

    private void addCardTitle(LinearLayout parent, String text) {
        TextView title = label(text, MoaColors.PAPER, 18, true);
        title.setPadding(0, 0, 0, dp(12));
        parent.addView(title);
    }

    // Required-access rows: short values shown as a colored chip on the right.
    // The label keeps weight so the row fills the card; values here stay short.
    private TextView accessRow(LinearLayout parent, String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(6), 0, dp(6));

        TextView left = label(label, MoaColors.PAPER, 14, false);
        row.addView(left, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView right = label(value, MoaColors.GOLD, 13, true);
        right.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(10), MoaColors.RAISED_BORDER, dp(1)));
        right.setPadding(dp(10), dp(4), dp(10), dp(4));
        LinearLayout.LayoutParams rightParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rightParams.leftMargin = dp(10);
        right.setLayoutParams(rightParams);
        row.addView(right);
        parent.addView(row);
        return right;
    }

    // Control-center rows: values can be long. Label takes its natural width so
    // it never wraps mid-word; the value takes the remaining width, right-aligns,
    // and wraps cleanly on the value side.
    private TextView statRow(LinearLayout parent, String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setPadding(0, dp(6), 0, dp(6));

        TextView left = label(label, MoaColors.PAPER, 14, false);
        left.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        row.addView(left);

        TextView right = label(value, MoaColors.GOLD, 14, true);
        right.setGravity(Gravity.END);
        LinearLayout.LayoutParams rightParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        rightParams.leftMargin = dp(12);
        right.setLayoutParams(rightParams);
        row.addView(right);
        parent.addView(row);
        return right;
    }

    private void addHint(LinearLayout parent, String text) {
        TextView hint = label(text, MoaColors.MUTED, 13, false);
        hint.setLineSpacing(dp(2), 1f);
        hint.setPadding(0, 0, 0, dp(8));
        parent.addView(hint);
    }

    private String requirementsSummary(boolean overlayGranted, boolean accessibilityGranted, boolean micGranted) {
        StringBuilder missing = new StringBuilder();
        appendMissing(missing, overlayGranted, "Draw over other apps");
        appendMissing(missing, accessibilityGranted, "Screen access");
        appendMissing(missing, micGranted, "Microphone");
        if (missing.length() == 0) {
            return "";
        }
        return "Missing: " + missing + ".";
    }

    private void appendMissing(StringBuilder builder, boolean granted, String label) {
        if (granted) {
            return;
        }
        if (builder.length() > 0) {
            builder.append(", ");
        }
        builder.append(label);
    }

    private EditText textInput(String hint, String value, int inputType) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setText(value);
        input.setHintTextColor(0x72EEF8E8);
        input.setTextColor(MoaColors.PAPER);
        input.setTextSize(15);
        input.setSingleLine(true);
        input.setInputType(inputType);
        input.setSelectAllOnFocus(true);
        input.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(14), MoaColors.RAISED_BORDER, dp(1)));
        input.setPadding(dp(12), 0, dp(12), 0);
        input.setMinHeight(dp(52));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dp(10);
        input.setLayoutParams(params);
        return input;
    }

    private Button primaryButton(String text) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(text);
        button.setTextColor(MoaColors.INK);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(MoaDrawables.horizontalGradient(MoaColors.GOLD, 0xFFFFF1A6, dp(16)));
        button.setPadding(dp(14), dp(12), dp(14), dp(12));
        button.setMinHeight(dp(52));
        button.setLayoutParams(buttonParams());
        return button;
    }

    private Button secondaryButton(String text) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(text);
        button.setTextColor(MoaColors.PAPER);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(16), MoaColors.RAISED_BORDER, dp(1)));
        button.setPadding(dp(14), dp(12), dp(14), dp(12));
        button.setMinHeight(dp(52));
        button.setLayoutParams(buttonParams());
        return button;
    }

    private LinearLayout.LayoutParams buttonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dp(12);
        return params;
    }

    private TextView label(String text, int color, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(color);
        view.setTextSize(sp);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT_BOLD);
        }
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

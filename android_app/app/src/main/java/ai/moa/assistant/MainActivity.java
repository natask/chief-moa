package ai.moa.assistant;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
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
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

public final class MainActivity extends Activity {
    static final String EXTRA_GATEWAY_URL = "ai.moa.assistant.extra.GATEWAY_URL";
    static final String EXTRA_GATEWAY_TOKEN = "ai.moa.assistant.extra.GATEWAY_TOKEN";
    static final String EXTRA_START_OVERLAY = "ai.moa.assistant.extra.START_OVERLAY";

    private static final int REQUEST_AUDIO = 4101;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private TextView overlayStatus;
    private TextView accessibilityStatus;
    private TextView micStatus;
    private TextView gatewayStatus;
    private TextView updateStatus;
    private TextView sessionsStatus;
    private TextView runsStatus;
    private TextView receiptsStatus;
    private TextView settingsStatus;
    private Button overlayButton;
    private Button accessibilityButton;
    private Button micButton;
    private Button startButton;
    private Button stopButton;
    private Button updateButton;
    private EditText gatewayUrlInput;
    private EditText gatewayTokenInput;
    private CheckBox spokenRepliesInput;
    private JSONObject pendingUpdate;
    private boolean autoStartedOverlay;
    private int gatewayHealthGeneration;
    private int updateCheckGeneration;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(MoaColors.INK);
        window.setNavigationBarColor(MoaColors.INK);

        applyIntentConfiguration(getIntent());
        setContentView(createContent());
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
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_AUDIO) {
            updatePermissionState();
        }
    }

    private View createContent() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        scrollView.setBackground(MoaDrawables.verticalGradient(MoaColors.INK, 0xFF10231B));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(34), dp(22), dp(26));
        scrollView.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        TextView eyebrow = label("ANDROID ASSISTANT", MoaColors.GOLD, 12, true);
        eyebrow.setLetterSpacing(0.14f);
        root.addView(eyebrow);

        TextView title = new TextView(this);
        title.setText("Aggie lives above\nthe phone.");
        title.setTextColor(MoaColors.PAPER);
        title.setTextSize(36);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setLineSpacing(0, 0.92f);
        title.setPadding(0, dp(8), 0, dp(10));
        root.addView(title);

        TextView body = new TextView(this);
        body.setText("Enable draw-over-apps, start the assistant circle, then tap to type or double-tap for continuous voice.");
        body.setTextColor(0xCCEEF8E8);
        body.setTextSize(15);
        body.setLineSpacing(dp(3), 1f);
        root.addView(body);

        root.addView(statusCard());
        root.addView(gatewayCard());
        root.addView(controlCenterCard());
        root.addView(actionCard());
        root.addView(scopeCard());

        return scrollView;
    }

    private View statusCard() {
        LinearLayout card = card();
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        addCardTitle(card, "Required access");

        overlayStatus = statusLine(card, "Screen overlay", "Checking...");
        accessibilityStatus = statusLine(card, "Screen access", "Checking...");
        micStatus = statusLine(card, "Microphone", "Checking...");
        gatewayStatus = statusLine(card, "Model gateway", "Checking...");
        updateStatus = statusLine(card, "App update", "Checking...");
        return card;
    }

    private View controlCenterCard() {
        LinearLayout card = card();
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        addCardTitle(card, "Control center");

        sessionsStatus = statusLine(card, "Sessions", "Checking...");
        runsStatus = statusLine(card, "Runs", "Checking...");
        receiptsStatus = statusLine(card, "Receipts", "Checking...");
        settingsStatus = statusLine(card, "Settings", MoaPrefs.spokenRepliesEnabled(this) ? "Spoken replies on" : "Text replies");

        Button refresh = secondaryButton("Refresh control center");
        refresh.setOnClickListener(v -> refreshControlCenter());
        card.addView(refresh);
        return card;
    }

    private View gatewayCard() {
        LinearLayout card = card();
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        addCardTitle(card, "Voice agent setup");

        TextView hint = label("Run the Aggie gateway on your server, then point this app at it. Model keys stay on the server and chat turns are saved there.", 0xB8EEF8E8, 15, false);
        hint.setLineSpacing(dp(2), 1f);
        hint.setPadding(0, 0, 0, dp(10));
        card.addView(hint);

        gatewayUrlInput = textInput("Gateway URL", MoaPrefs.gatewayUrl(this), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        card.addView(gatewayUrlInput);

        gatewayTokenInput = textInput("Gateway token (optional)", MoaPrefs.gatewayToken(this), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        card.addView(gatewayTokenInput);

        spokenRepliesInput = new CheckBox(this);
        spokenRepliesInput.setText("Play spoken replies");
        spokenRepliesInput.setTextColor(MoaColors.PAPER);
        spokenRepliesInput.setTextSize(15);
        spokenRepliesInput.setChecked(MoaPrefs.spokenRepliesEnabled(this));
        spokenRepliesInput.setPadding(0, dp(8), 0, dp(4));
        card.addView(spokenRepliesInput);

        Button saveButton = primaryButton("Save voice agent settings");
        saveButton.setOnClickListener(v -> saveGatewaySettings());
        card.addView(saveButton);

        updateButton = secondaryButton("Check for app update");
        updateButton.setOnClickListener(v -> {
            if (pendingUpdate != null) {
                installPendingUpdate();
            } else {
                checkForAppUpdate(true);
            }
        });
        card.addView(updateButton);
        return card;
    }

    private View actionCard() {
        LinearLayout card = card();
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        addCardTitle(card, "Launch Aggie");

        overlayButton = primaryButton("Enable overlay permission");
        overlayButton.setOnClickListener(v -> openOverlaySettings());
        card.addView(overlayButton);

        accessibilityButton = primaryButton("Enable screen access");
        accessibilityButton.setOnClickListener(v -> openAccessibilitySettings());
        card.addView(accessibilityButton);

        micButton = secondaryButton("Enable microphone");
        micButton.setOnClickListener(v -> requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO));
        card.addView(micButton);

        startButton = primaryButton("Start assistant circle");
        startButton.setOnClickListener(v -> startOverlay());
        card.addView(startButton);

        stopButton = secondaryButton("Stop overlay");
        stopButton.setOnClickListener(v -> stopService(new Intent(this, OverlayService.class)));
        card.addView(stopButton);

        return card;
    }

    private View scopeCard() {
        LinearLayout card = card();
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        addCardTitle(card, "What this build does");
        addBullet(card, "Floating animated circle over other apps.");
        addBullet(card, "Tap the orb to type; double-tap starts continuous voice, like the browser mark.");
        addBullet(card, "Silence commits each spoken turn and the mic re-arms after the reply.");
        addBullet(card, "Gemini-style live transcript overlay while speaking.");
        addBullet(card, "Voice streams through Gemini Live only after an explicit voice gesture.");
        addBullet(card, "Screen access reads visible app text and passes it to gateway replies and home-machine agent runs.");
        addBullet(card, "Assistant calls the self-hosted Aggie gateway when configured, with local fallback replies if the server is unavailable.");
        addBullet(card, "Voice commands that ask Aggie to build, fix, change, or test something can run the Gemini harness on the home machine.");
        addBullet(card, "Voice-originated replies speak back with Android TextToSpeech.");
        return card;
    }

    private void updatePermissionState() {
        boolean overlayGranted = Settings.canDrawOverlays(this);
        boolean accessibilityGranted = MoaAccessibilityService.isEnabled(this);
        boolean micGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;

        if (overlayStatus != null) {
            overlayStatus.setText(overlayGranted ? "Ready" : "Needs permission");
            overlayStatus.setTextColor(overlayGranted ? MoaColors.OK : MoaColors.WARN);
        }

        if (accessibilityStatus != null) {
            accessibilityStatus.setText(accessibilityGranted ? "Ready" : "Optional");
            accessibilityStatus.setTextColor(accessibilityGranted ? MoaColors.OK : MoaColors.WARN);
        }

        if (micStatus != null) {
            micStatus.setText(micGranted ? "Ready" : "Needs permission");
            micStatus.setTextColor(micGranted ? MoaColors.OK : MoaColors.WARN);
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
            }
        }

        if (overlayButton != null) {
            overlayButton.setVisibility(overlayGranted ? View.GONE : View.VISIBLE);
        }

        if (accessibilityButton != null) {
            accessibilityButton.setVisibility(accessibilityGranted ? View.GONE : View.VISIBLE);
        }

        if (micButton != null) {
            micButton.setVisibility(micGranted ? View.GONE : View.VISIBLE);
        }

        if (startButton != null) {
            startButton.setEnabled(overlayGranted);
            startButton.setAlpha(overlayGranted ? 1f : 0.45f);
        }

        if (updateButton != null && pendingUpdate != null) {
            updateButton.setText("Install app update");
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
        updatePermissionState();
    }

    private void refreshControlCenter() {
        if (sessionsStatus == null || runsStatus == null || receiptsStatus == null) {
            return;
        }

        receiptsStatus.setText(MoaActionReceiptStore.receipts(this).length() + " local");
        receiptsStatus.setTextColor(MoaColors.OK);
        if (settingsStatus != null) {
            settingsStatus.setText(MoaPrefs.spokenRepliesEnabled(this) ? "Spoken replies on" : "Text replies");
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

        new Thread(() -> {
            String sessionsLabel = "Unavailable";
            String runsLabel = "Unavailable";
            int sessionsColor = MoaColors.GOLD;
            int runsColor = MoaColors.GOLD;
            try {
                MoaGatewayClient client = new MoaGatewayClient(gatewayUrl, MoaPrefs.gatewayToken(this));
                JSONObject context = client.latestContext();
                JSONArray sessions = context.optJSONArray("sessions");
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
                int sessionCount = sessions == null ? 0 : sessions.length();
                int runCount = runs == null ? 0 : runs.length();
                sessionsLabel = sessionCount == 1 ? "1 session" : sessionCount + " sessions";
                runsLabel = activeRuns > 0 ? activeRuns + " active / " + runCount + " recent" : runCount + " recent";
                sessionsColor = MoaColors.OK;
                runsColor = MoaColors.OK;
            } catch (Exception ignored) {
            }

            final String nextSessions = sessionsLabel;
            final String nextRuns = runsLabel;
            final int nextSessionsColor = sessionsColor;
            final int nextRunsColor = runsColor;
            mainHandler.post(() -> {
                if (sessionsStatus != null) {
                    sessionsStatus.setText(nextSessions);
                    sessionsStatus.setTextColor(nextSessionsColor);
                }
                if (runsStatus != null) {
                    runsStatus.setText(nextRuns);
                    runsStatus.setTextColor(nextRunsColor);
                }
            });
        }, "moa-control-center").start();
    }

    private void setControlCenterGatewayRequired() {
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
    }

    private void checkGatewayHealth(String gatewayUrl) {
        final int generation = ++gatewayHealthGeneration;
        final String healthUrl = gatewayEndpoint(gatewayUrl, "/health");

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

            final boolean isReachable = reachable;
            final String status = label;
            mainHandler.post(() -> {
                if (generation != gatewayHealthGeneration || gatewayStatus == null) {
                    return;
                }
                gatewayStatus.setText(status);
                gatewayStatus.setTextColor(isReachable ? MoaColors.OK : MoaColors.WARN);
            });
        }, "moa-gateway-health").start();
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
            try {
                MoaGatewayClient client = new MoaGatewayClient(gatewayUrl, MoaPrefs.gatewayToken(this));
                JSONObject manifest = client.latestAndroidUpdate();
                long remoteVersionCode = manifest.optLong("version_code", 0);
                String remoteGitSha = manifest.optString("git_sha", "").trim();
                String currentGitSha = BuildConfig.GIT_SHA == null ? "" : BuildConfig.GIT_SHA.trim();
                boolean sameSource = !remoteGitSha.isEmpty() && remoteGitSha.equals(currentGitSha);
                if (!sameSource && remoteVersionCode > currentVersionCode()) {
                    update = manifest;
                    label = "v" + manifest.optString("version_name", String.valueOf(remoteVersionCode)) + " available";
                    color = MoaColors.OK;
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
            final String nextLabel = label;
            final int nextColor = color;
            mainHandler.post(() -> {
                if (generation != updateCheckGeneration) {
                    return;
                }
                pendingUpdate = nextUpdate;
                if (updateStatus != null) {
                    updateStatus.setText(nextLabel);
                    updateStatus.setTextColor(nextColor);
                }
                if (updateButton != null) {
                    updateButton.setEnabled(true);
                    updateButton.setAlpha(1f);
                    updateButton.setText(nextUpdate == null ? "Check for app update" : "Install app update");
                    updateButton.setOnClickListener(v -> {
                        if (pendingUpdate == null) {
                            checkForAppUpdate(true);
                        } else {
                            installPendingUpdate();
                        }
                    });
                }
            });
        }, "moa-update-check").start();
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

    private void launchInstaller() {
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
        } catch (ActivityNotFoundException error) {
            if (updateStatus != null) {
                updateStatus.setText("No installer");
                updateStatus.setTextColor(MoaColors.GOLD);
            }
        } finally {
            if (updateButton != null) {
                updateButton.setEnabled(true);
                updateButton.setAlpha(1f);
            }
        }
    }

    private void verifyDownloadedUpdate(JSONObject update, File apk) throws Exception {
        long expectedSize = update.optLong("size_bytes", 0);
        if (expectedSize > 0 && apk.length() != expectedSize) {
            throw new IllegalStateException("APK size mismatch");
        }
        String expectedSha = update.optString("sha256", "").trim();
        if (!expectedSha.isEmpty() && !expectedSha.equalsIgnoreCase(sha256Hex(apk))) {
            throw new IllegalStateException("APK checksum mismatch");
        }
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
        card.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(28), 0x18FFFFFF, dp(1)));
        card.setElevation(dp(8));

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dp(18);
        card.setLayoutParams(params);
        return card;
    }

    private void addCardTitle(LinearLayout parent, String text) {
        TextView title = label(text, MoaColors.PAPER, 20, true);
        title.setPadding(0, 0, 0, dp(12));
        parent.addView(title);
    }

    private TextView statusLine(LinearLayout parent, String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(7), 0, dp(7));

        TextView left = label(label, 0xB8EEF8E8, 15, false);
        row.addView(left, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView right = label(value, MoaColors.GOLD, 15, true);
        row.addView(right);
        parent.addView(row);
        return right;
    }

    private void addBullet(LinearLayout parent, String text) {
        TextView bullet = new TextView(this);
        bullet.setText("• " + text);
        bullet.setTextColor(0xCDEEF8E8);
        bullet.setTextSize(15);
        bullet.setLineSpacing(dp(2), 1f);
        bullet.setPadding(0, dp(5), 0, dp(5));
        parent.addView(bullet);
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
        input.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(16), 0x18FFFFFF, dp(1)));
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
        button.setBackground(MoaDrawables.horizontalGradient(MoaColors.GOLD, 0xFFFFF1A6, dp(18)));
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
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
        button.setBackground(MoaDrawables.rounded(0x18FFFFFF, dp(18), 0x20FFFFFF, dp(1)));
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setMinHeight(dp(52));
        button.setLayoutParams(buttonParams());
        return button;
    }

    private LinearLayout.LayoutParams buttonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dp(10);
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

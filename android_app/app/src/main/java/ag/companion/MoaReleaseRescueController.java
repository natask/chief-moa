package ag.companion;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

/** Voice/model-independent native view for exact stable recovery. */
final class MoaReleaseRescueController {
    private final Activity activity;
    private final String origin;
    private final String token;
    private final String deviceId;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final MoaReleaseRescueCache cache;
    private TextView installed;
    private TextView stable;
    private TextView trial;
    private TextView status;
    private Button stableAction;
    private AlertDialog dialog;
    private MoaReleaseRescueCache.Snapshot snapshot;
    private MoaForwardRecoveryManifest forwardRecovery;

    MoaReleaseRescueController(
            Activity activity, String origin, String token, String deviceId) {
        this.activity = activity;
        this.origin = origin == null ? "" : origin.trim();
        this.token = token == null ? "" : token.trim();
        this.deviceId = deviceId == null ? "" : deviceId.trim();
        this.cache = new MoaReleaseRescueCache(activity);
    }

    void show() {
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int spacing = dp(12);
        content.setPadding(spacing * 2, spacing, spacing * 2, spacing);
        TextView explanation = text(
                "This screen does not use voice, a model, or conversation access. "
                        + "It can only inspect release state and hand exact verified APK bytes to Android.",
                MoaColors.MUTED, 13);
        content.addView(explanation);
        installed = row(content, "Installed");
        stable = row(content, "Stable");
        trial = row(content, "Trial");
        status = text("Reading app-private recovery cache…", MoaColors.GOLD, 13);
        status.setPadding(0, spacing, 0, 0);
        content.addView(status);
        stableAction = button("Stable restore unavailable");
        stableAction.setEnabled(false);
        stableAction.setOnClickListener(view -> recoverStable());
        content.addView(stableAction);
        Button refresh = button("Refresh recovery metadata");
        refresh.setOnClickListener(view -> refresh());
        content.addView(refresh);
        dialog = new AlertDialog.Builder(activity)
                .setTitle("Release rescue")
                .setView(content)
                .setNegativeButton("Close", null)
                .create();
        dialog.show();
        loadCached();
        refresh();
    }

    private void loadCached() {
        forwardRecovery = null;
        try {
            snapshot = cache.load(origin, deviceId);
            if (snapshot != null && !currentSignerDigests().equals(
                    new HashSet<>(snapshot.signerDigests))) {
                snapshot = null;
            }
            if (snapshot != null && snapshot.forwardRecovery != null
                    && snapshot.forwardRecovery.matchesInstalled(currentVersionCode(),
                            MoaUpdateArtifact.sha256Hex(
                                    new File(activity.getApplicationInfo().sourceDir)),
                            currentSignerDigests())) {
                forwardRecovery = snapshot.forwardRecovery;
            }
        } catch (Exception ignored) {
            snapshot = null;
        }
        render(snapshot == null
                ? "No verified release metadata is cached. Trying the recovery endpoint…"
                : "Showing cached exact metadata. Refreshing through release-only access…",
                snapshot == null ? MoaColors.WARN : MoaColors.GOLD);
    }

    private void refresh() {
        status("Refreshing through release-only device access…", MoaColors.GOLD);
        stableAction.setEnabled(false);
        new Thread(() -> {
            try {
                MoaReleaseRecoveryClient client = new MoaReleaseRecoveryClient(
                        origin, token, deviceId);
                org.json.JSONObject manifest = client.view();
                MoaReleaseSelectionPolicy.View view =
                        MoaReleaseSelectionPolicy.parseView(manifest);
                MoaForwardRecoveryManifest nextRecovery =
                        MoaForwardRecoveryManifest.recommended(manifest, origin, deviceId,
                                currentVersionCode(), MoaUpdateArtifact.sha256Hex(
                                        new File(activity.getApplicationInfo().sourceDir)));
                MoaReleaseRescueCache.Snapshot next = MoaReleaseRescueCache.fromView(
                        origin, deviceId, currentVersionName(), currentVersionCode(),
                        MoaUpdateArtifact.sha256Hex(new File(activity.getApplicationInfo().sourceDir)),
                        new ArrayList<>(currentSignerDigests()), view, System.currentTimeMillis())
                        .withForwardRecovery(nextRecovery);
                cache.save(next);
                main.post(() -> {
                    if (!active()) return;
                    snapshot = next;
                    forwardRecovery = nextRecovery;
                    render(nextRecovery == null
                                    ? "Stable metadata refreshed. No forward recovery artifact is available."
                                    : "Forward recovery verified against Stable and the installed app.",
                            nextRecovery == null ? MoaColors.WARN : MoaColors.OK);
                });
            } catch (IllegalArgumentException stale) {
                MoaReleaseRescueCache.Snapshot current = snapshot;
                if (current != null) {
                    try {
                        cache.save(current.withForwardRecovery(null));
                    } catch (Exception ignored) { }
                }
                main.post(() -> {
                    if (!active()) return;
                    forwardRecovery = null;
                    render("Recovery provenance is stale or invalid. No install is offered.",
                            MoaColors.WARN);
                });
            } catch (Exception ignored) {
                main.post(() -> {
                    if (active()) render(snapshot == null
                            ? "Recovery metadata is unavailable. No restore action is offered."
                            : "Offline: cached metadata remains visible; APK availability is checked separately.",
                            MoaColors.WARN);
                });
            }
        }, "ag-release-rescue-refresh").start();
    }

    private void render(String message, int color) {
        try {
            installed.setText("v" + currentVersionName() + " · code " + currentVersionCode()
                    + " · " + shortSha(MoaUpdateArtifact.sha256Hex(
                    new File(activity.getApplicationInfo().sourceDir))));
        } catch (Exception ignored) {
            installed.setText("Could not verify installed app identity");
        }
        stable.setText(entryLabel(snapshot == null ? null : snapshot.stable));
        trial.setText(entryLabel(snapshot == null ? null : snapshot.trial));
        status(message, color);
        MoaReleaseRescuePolicy.Action action = action();
        stableAction.setText(MoaReleaseRescuePolicy.label(action));
        stableAction.setEnabled(action == MoaReleaseRescuePolicy.Action.INSTALL_CACHED
                || action == MoaReleaseRescuePolicy.Action.DOWNLOAD_AND_INSTALL);
        stableAction.setAlpha(stableAction.isEnabled() ? 1f : 0.5f);
    }

    private MoaReleaseRescuePolicy.Action action() {
        if (forwardRecovery == null) return MoaReleaseRescuePolicy.Action.UNAVAILABLE;
        File cached = MoaUpdateArtifact.updateApkFile(activity.getCacheDir());
        return cached.isFile() && cached.length() == forwardRecovery.artifactSizeBytes
                ? MoaReleaseRescuePolicy.Action.INSTALL_CACHED
                : MoaReleaseRescuePolicy.Action.DOWNLOAD_AND_INSTALL;
    }

    private void recoverStable() {
        MoaForwardRecoveryManifest recovery = forwardRecovery;
        MoaReleaseRescuePolicy.Action action = action();
        if (recovery == null || (action != MoaReleaseRescuePolicy.Action.INSTALL_CACHED
                && action != MoaReleaseRescuePolicy.Action.DOWNLOAD_AND_INSTALL)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            status("Allow installs, then reopen release rescue. Nothing was installed.", MoaColors.GOLD);
            return;
        }
        new AlertDialog.Builder(activity)
                .setTitle("Review exact stable restore")
                .setMessage("Ag will " + (action == MoaReleaseRescuePolicy.Action.INSTALL_CACHED
                        ? "verify the cached forward recovery APK"
                        : "download and verify the exact forward recovery APK")
                        + ". Android will still ask you to approve installation. "
                        + "Ag will not uninstall the current app.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Continue", (ignored, which) ->
                        downloadVerifyAndOpen(recovery, action))
                .show();
    }

    private void downloadVerifyAndOpen(
            MoaForwardRecoveryManifest recovery, MoaReleaseRescuePolicy.Action action) {
        stableAction.setEnabled(false);
        status(action == MoaReleaseRescuePolicy.Action.INSTALL_CACHED
                ? "Verifying cached recovery APK…" : "Downloading exact recovery APK…",
                MoaColors.GOLD);
        new Thread(() -> {
            try {
                File apk = MoaUpdateArtifact.updateApkFile(activity.getCacheDir());
                if (action != MoaReleaseRescuePolicy.Action.INSTALL_CACHED) {
                    new MoaReleaseRecoveryClient(origin, token, deviceId).download(recovery, apk);
                }
                MoaReleaseArtifactVerifier.verifyForwardRecovery(activity.getPackageManager(),
                        activity.getPackageName(), apk, recovery.artifactVersionCode,
                        recovery.artifactSha256, recovery.artifactSizeBytes,
                        recovery.artifactSignerSha256);
                if (recovery.artifactVersionCode <= currentVersionCode()) {
                    throw new IllegalStateException("forward recovery build is required");
                }
                main.post(this::openInstaller);
            } catch (Exception ignored) {
                main.post(() -> {
                    if (active()) render(
                            "Stable APK download or verification failed. Nothing was installed.",
                            MoaColors.WARN);
                });
            }
        }, "ag-release-rescue-install").start();
    }

    private void openInstaller() {
        if (!active()) return;
        Uri apk = Uri.parse("content://" + activity.getPackageName()
                + ".apkprovider/ota/" + MoaApkProvider.APK_NAME);
        Intent install = MoaRecoveryInstallContract.review(apk);
        try {
            activity.startActivity(install);
            render("Exact bytes and continuity signer verified. Android installer opened.", MoaColors.OK);
        } catch (ActivityNotFoundException error) {
            render("No Android package installer is available. Nothing was installed.", MoaColors.WARN);
        }
    }

    private Set<String> currentSignerDigests() throws Exception {
        return MoaReleaseArtifactVerifier.installedSignerDigests(
                activity.getPackageManager(), activity.getPackageName());
    }

    private long currentVersionCode() throws Exception {
        return MoaUpdateArtifact.currentVersionCode(
                activity.getPackageManager(), activity.getPackageName());
    }

    private String currentVersionName() throws Exception {
        return MoaUpdateArtifact.currentVersionName(
                activity.getPackageManager(), activity.getPackageName());
    }

    private boolean active() {
        return dialog != null && dialog.isShowing() && !activity.isFinishing();
    }

    private String entryLabel(MoaReleaseRescueCache.Entry entry) {
        return entry == null ? "Not cached" : "v" + entry.versionName + " · "
                + entry.releaseId + " · " + shortSha(entry.sha256);
    }

    private static String shortSha(String value) {
        return value == null || value.length() < 12 ? "unverified" : value.substring(0, 12);
    }

    private void status(String message, int color) {
        status.setText(message);
        status.setTextColor(color);
    }

    private TextView row(LinearLayout parent, String label) {
        LinearLayout row = new LinearLayout(activity);
        row.setPadding(0, dp(8), 0, 0);
        TextView name = text(label, MoaColors.PAPER, 14);
        row.addView(name);
        TextView value = text("Checking…", MoaColors.GOLD, 13);
        value.setGravity(Gravity.END);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.leftMargin = dp(12);
        row.addView(value, params);
        parent.addView(row);
        return value;
    }

    private Button button(String label) {
        Button result = new Button(activity);
        result.setText(label);
        result.setAllCaps(false);
        return result;
    }

    private TextView text(String value, int color, int size) {
        TextView result = new TextView(activity);
        result.setText(value);
        result.setTextColor(color);
        result.setTextSize(size);
        return result;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}

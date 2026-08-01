package ag.companion;

import android.content.Context;
import android.os.Handler;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/** Compact full-app authority for reading and forking the active gateway thread. */
final class MoaThreadControls {
    static final class Snapshot {
        final String branchId;
        final String label;

        Snapshot(String branchId, String label) {
            this.branchId = branchId == null ? "" : branchId.trim();
            this.label = label == null ? "" : label.trim();
        }

        boolean available() {
            return !branchId.isEmpty();
        }
    }

    private final Context context;
    private final Handler mainHandler;
    private final Runnable onBranchChanged;
    private final LinearLayout view;
    private final TextView status;
    private final Button branchButton;
    private int generation;
    private String activeBranchId = "default";

    MoaThreadControls(Context context, Handler mainHandler, Runnable onBranchChanged) {
        this.context = context;
        this.mainHandler = mainHandler;
        this.onBranchChanged = onBranchChanged;
        view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(context);
        status.setTextSize(12);
        status.setTextColor(MoaColors.GOLD);
        status.setText("Thread · Loading...");
        status.setPadding(0, dp(8), 0, dp(4));
        view.addView(status, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        branchButton = new Button(context);
        branchButton.setText("Branch from here");
        branchButton.setTextColor(MoaColors.PAPER);
        branchButton.setTextSize(13);
        branchButton.setAllCaps(false);
        branchButton.setBackground(MoaDrawables.rounded(
                MoaColors.RAISED, dp(10), MoaColors.RAISED_BORDER, dp(1)));
        branchButton.setContentDescription("Create a child thread from the current conversation");
        branchButton.setEnabled(false);
        branchButton.setOnClickListener(ignored -> fork());
        view.addView(branchButton, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));
    }

    View view() {
        return view;
    }

    void setLoading() {
        generation++;
        status.setText("Thread · Loading...");
        status.setTextColor(MoaColors.GOLD);
        branchButton.setEnabled(false);
    }

    void setGatewayRequired() {
        generation++;
        status.setText("Thread · Gateway required");
        status.setTextColor(MoaColors.GOLD);
        branchButton.setEnabled(false);
    }

    void apply(Snapshot snapshot) {
        Snapshot value = snapshot == null ? new Snapshot("", "Thread unavailable") : snapshot;
        if (value.available()) activeBranchId = value.branchId;
        status.setText("Thread · " + (value.label.isEmpty() ? "Thread unavailable" : value.label));
        status.setTextColor(value.available() ? MoaColors.OK : MoaColors.WARN);
        branchButton.setEnabled(value.available());
    }

    static Snapshot resolve(MoaGatewayClient client, String sessionId) {
        try {
            JSONObject payload = client.activeThread(sessionId, "android");
            JSONObject active = payload.optJSONObject("active");
            if (active == null) return new Snapshot("", "Thread unavailable");
            String branchId = active.optString("branch_id", "").trim();
            String label = active.optString("label", "").trim();
            String kind = active.optString("kind", "").trim();
            if (label.isEmpty()) label = branchId;
            if (!kind.isEmpty() && !"default".equals(kind)) label += " · " + kind;
            return new Snapshot(branchId, label);
        } catch (Exception ignored) {
            return new Snapshot("", "Thread unavailable");
        }
    }

    private void fork() {
        String gatewayUrl = MoaPrefs.gatewayUrl(context);
        String sessionId = MoaPrefs.conversationId(context);
        if (gatewayUrl == null || gatewayUrl.trim().isEmpty()
                || sessionId == null || sessionId.trim().isEmpty()
                || activeBranchId.isEmpty()) {
            status.setText("Thread · Connect the gateway before branching");
            status.setTextColor(MoaColors.WARN);
            return;
        }
        int requestGeneration = ++generation;
        branchButton.setEnabled(false);
        branchButton.setText("Branching...");
        status.setText("Thread · Creating child thread...");
        status.setTextColor(MoaColors.GOLD);
        new Thread(() -> {
            String resolved = "";
            try {
                JSONObject response = new MoaGatewayClient(
                        gatewayUrl, MoaPrefs.gatewayToken(context)).switchThread(new JSONObject()
                        .put("session_id", sessionId)
                        .put("action", "fork")
                        .put("parent_branch_id", activeBranchId)
                        .put("surface", "android")
                        .put("device_id", androidDeviceId()));
                resolved = MoaGatewayClient.branchIdFromSwitch(response);
            } catch (Exception ignored) {
            }
            String branchId = resolved;
            mainHandler.post(() -> finishFork(requestGeneration, sessionId, branchId));
        }, "moa-thread-fork").start();
    }

    private void finishFork(int requestGeneration, String sessionId, String branchId) {
        if (requestGeneration != generation) return;
        branchButton.setText("Branch from here");
        if (branchId == null || branchId.isEmpty()) {
            status.setText("Thread · Branch could not be created. Try again.");
            status.setTextColor(MoaColors.WARN);
            branchButton.setEnabled(true);
            return;
        }
        activeBranchId = branchId;
        // The overlay reloads this preference before every new capture, so the
        // full-app branch action and the compact voice/chat surface cannot
        // diverge even when the overlay process is already alive.
        MoaPrefs.setConversationBranchId(context, sessionId, branchId);
        status.setText("Thread · Child thread ready");
        status.setTextColor(MoaColors.OK);
        onBranchChanged.run();
    }

    private String androidDeviceId() {
        String raw = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        String safe = raw == null ? "" : raw.replaceAll("[^a-zA-Z0-9_-]", "");
        return "android_" + (safe.isEmpty() ? "unknown" : safe);
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}

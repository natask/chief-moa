package ai.moa.assistant;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.UUID;

/** Full-app release UI. Assignment is always separate from Android installation. */
final class MoaReleaseCardController {
    interface Host {
        String gatewayUrl();
        String gatewayToken();
        String deviceId();
        String installedLabel();
        long installedVersionCode() throws Exception;
        String installedVersionName() throws Exception;
        String installedArtifactSha256() throws Exception;
        void reviewInstall(
                MoaReleaseSelectionPolicy.Candidate candidate,
                String gatewayUrl,
                String gatewayToken);
    }

    private final Activity activity;
    private final Host host;
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView installedStatus;
    private TextView assignmentStatus;
    private TextView stableStatus;
    private TextView previewStatus;
    private TextView actionStatus;
    private Button stableButton;
    private Button previewButton;
    private Button installButton;
    private Button feedbackButton;
    private EditText feedbackInput;
    private int generation;
    private MoaReleaseSelectionPolicy.View view;
    private MoaReleaseSelectionPolicy.Candidate selected;
    private String pinnedGatewayUrl = "";
    private String pinnedGatewayToken = "";
    private String localInstalledSha256 = "";
    private boolean disposed;

    MoaReleaseCardController(Activity activity, Host host) {
        this.activity = activity;
        this.host = host;
    }

    View createView() {
        LinearLayout card = card();
        TextView title = text("Release", MoaColors.PAPER, 18, true);
        title.setPadding(0, 0, 0, dp(12));
        card.addView(title);
        TextView hint = text(
                "Choose what this phone follows. Selecting a release never installs it.",
                MoaColors.MUTED, 13, false);
        hint.setPadding(0, 0, 0, dp(8));
        card.addView(hint);

        installedStatus = statRow(card, "Installed", host.installedLabel());
        assignmentStatus = statRow(card, "Assigned", "Checking...");
        stableStatus = statRow(card, "Stable", "Checking...");
        previewStatus = statRow(card, "Preview", "Checking...");
        actionStatus = text("Loading release control...", MoaColors.MUTED, 13, false);
        actionStatus.setPadding(0, dp(10), 0, 0);
        card.addView(actionStatus);

        Button refresh = secondary("Refresh releases");
        refresh.setOnClickListener(v -> refresh());
        card.addView(refresh);
        previewButton = secondary("Use preview");
        previewButton.setEnabled(false);
        previewButton.setOnClickListener(v -> select("preview"));
        card.addView(previewButton);
        stableButton = secondary("Return to stable");
        stableButton.setEnabled(false);
        stableButton.setOnClickListener(v -> select("stable"));
        card.addView(stableButton);
        installButton = primary("Download and review install");
        installButton.setVisibility(View.GONE);
        installButton.setOnClickListener(v -> {
            if (selected != null && selected.installable()) {
                host.reviewInstall(selected, pinnedGatewayUrl, pinnedGatewayToken);
            }
        });
        card.addView(installButton);

        feedbackInput = input("Feedback on this exact release");
        card.addView(feedbackInput);
        feedbackButton = secondary("Submit release feedback");
        feedbackButton.setEnabled(false);
        feedbackButton.setOnClickListener(v -> submitFeedback());
        card.addView(feedbackButton);
        return card;
    }

    void refresh() {
        String gateway = host.gatewayUrl();
        String token = host.gatewayToken();
        if (gateway == null || gateway.trim().isEmpty()) {
            unavailable("Gateway required. Current app behavior is unchanged.");
            return;
        }
        int currentGeneration = ++generation;
        status("Loading release control...", MoaColors.MUTED);
        buttons(false, false);
        new Thread(() -> {
            try {
                MoaReleaseControlClient client = releaseClient(gateway, token);
                MoaReleaseSelectionPolicy.View next =
                        MoaReleaseSelectionPolicy.parseView(client.view(host.deviceId()));
                String installedSha = host.installedArtifactSha256();
                MoaReleaseSelectionPolicy.Candidate assigned = candidateForAssignment(next);
                if (MoaReleaseSelectionPolicy.localMatchesAssignment(next, assigned, installedSha)
                        && assigned.artifact.versionCode == host.installedVersionCode()
                        && assigned.artifact.versionName.equals(host.installedVersionName())
                        && !MoaReleaseSelectionPolicy.exactRunningSelection(
                        next, assigned, installedSha)) {
                    JSONObject receipt = MoaReleaseSelectionPolicy.installReceipt(
                            host.deviceId(), next.assignment, assigned, "activated",
                            "running_apk_digest_and_version_match",
                            "activated-" + next.assignment.sequence + "-"
                                    + installedSha.substring(0, 16));
                    client.installReceipt(receipt);
                    next = MoaReleaseSelectionPolicy.parseView(client.view(host.deviceId()));
                }
                MoaReleaseSelectionPolicy.View resolved = next;
                main.post(() -> {
                    if (!active(currentGeneration)) return;
                    pinnedGatewayUrl = gateway;
                    pinnedGatewayToken = token;
                    localInstalledSha256 = installedSha;
                    view = resolved;
                    selected = candidateForAssignment(resolved);
                    render("Release control ready.", MoaColors.OK);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (active(currentGeneration)) {
                        unavailable("Release control unavailable. Current app behavior is unchanged.");
                    }
                });
            }
        }, "moa-release-view").start();
    }

    void unavailable(String message) {
        generation++;
        view = null;
        selected = null;
        buttons(false, false);
        if (assignmentStatus != null) assignmentStatus.setText("Unavailable");
        if (stableStatus != null) stableStatus.setText("Unavailable");
        if (previewStatus != null) previewStatus.setText("Unavailable");
        if (installButton != null) installButton.setVisibility(View.GONE);
        if (feedbackButton != null) feedbackButton.setEnabled(false);
        status(message, MoaColors.WARN);
    }

    void close() {
        disposed = true;
        generation++;
    }

    void setInstallBusy(boolean busy) {
        if (installButton != null) installButton.setEnabled(!busy);
    }

    void showInstallStatus(String message, int color) {
        render(message, color);
    }

    void postInstallReceiptBestEffort(
            MoaReleaseSelectionPolicy.Candidate candidate, String state, String detail) {
        try {
            if (view == null || view.assignment == null) return;
            JSONObject body = MoaReleaseSelectionPolicy.installReceipt(
                    host.deviceId(), view.assignment, candidate, state, detail, requestId("install"));
            releaseClient(pinnedGatewayUrl, pinnedGatewayToken).installReceipt(body);
        } catch (Exception ignored) {
            // Receipt transport never changes Android's installation authority.
        }
    }

    private void render(String message, int color) {
        if (installedStatus != null) installedStatus.setText(host.installedLabel());
        if (view == null) {
            unavailable(message);
            return;
        }
        if (view.assignment == null) {
            assignmentStatus.setText("None");
        } else {
            String source = view.assignment.source.isEmpty() ? "" : " · " + view.assignment.source;
            assignmentStatus.setText(view.assignment.channel + " · " + view.assignment.releaseId
                    + source + " · selected, not installed");
        }
        renderCandidate(stableStatus, view.stable);
        renderCandidate(previewStatus, view.preview);
        buttons(view.stable != null && view.stable.compatible,
                view.preview != null && view.preview.compatible);
        boolean bound = exactRunningSelection();
        feedbackButton.setEnabled(bound);
        installButton.setVisibility(selected != null && selected.installable()
                ? View.VISIBLE : View.GONE);
        status(message, color);
    }

    private void select(String channel) {
        MoaReleaseSelectionPolicy.View current = view;
        MoaReleaseSelectionPolicy.Candidate candidate = current == null ? null
                : ("preview".equals(channel) ? current.preview : current.stable);
        if (current == null || candidate == null || !candidate.compatible) {
            render("That release is not compatible with this phone.", MoaColors.WARN);
            return;
        }
        buttons(false, false);
        status("Selecting " + channel + "...", MoaColors.GOLD);
        int operationGeneration = ++generation;
        String gateway = pinnedGatewayUrl;
        String token = pinnedGatewayToken;
        new Thread(() -> {
            try {
                long sequence = current.assignment == null ? 0L : current.assignment.sequence;
                boolean fallback = "stable".equals(channel) && current.hasLastKnownGood;
                JSONObject body = fallback
                        ? MoaReleaseSelectionPolicy.fallbackRequest(
                                host.deviceId(), sequence, requestId("assignment"))
                        : MoaReleaseSelectionPolicy.assignmentRequest(
                                host.deviceId(), channel, candidate, sequence, requestId("assignment"));
                MoaReleaseControlClient client = releaseClient(gateway, token);
                JSONObject response = fallback
                        ? client.fallback(body) : client.assign(body);
                MoaReleaseSelectionPolicy.Candidate offered =
                        MoaReleaseSelectionPolicy.selectedCandidate(response, channel);
                MoaReleaseSelectionPolicy.Assignment assignment =
                        MoaReleaseSelectionPolicy.assignmentFromResponse(response);
                main.post(() -> {
                    if (!active(operationGeneration)) return;
                    selected = offered.artifact == null ? candidate : offered;
                    view = new MoaReleaseSelectionPolicy.View(
                            current.reportedInstalledReleaseId,
                            current.reportedInstalledSha256,
                            assignment, current.stable, current.preview,
                            current.hasLastKnownGood, current.candidates);
                    render(capitalize(channel) + " selected — not installed.", MoaColors.GOLD);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (active(operationGeneration)) render(
                            "Selection failed. Refresh and try again; nothing was installed.",
                            MoaColors.WARN);
                });
            }
        }, "moa-release-select").start();
    }

    private void submitFeedback() {
        MoaReleaseSelectionPolicy.View current = view;
        MoaReleaseSelectionPolicy.Candidate candidate = selected;
        String comment = feedbackInput == null ? "" : feedbackInput.getText().toString();
        if (current == null || current.assignment == null || candidate == null) {
            render("Select an exact release before sending feedback.", MoaColors.WARN);
            return;
        }
        if (!exactRunningSelection()) {
            render("Feedback requires the exact release currently running on this phone.",
                    MoaColors.WARN);
            return;
        }
        feedbackButton.setEnabled(false);
        int operationGeneration = ++generation;
        String gateway = pinnedGatewayUrl;
        String token = pinnedGatewayToken;
        new Thread(() -> {
            try {
                JSONObject body = MoaReleaseSelectionPolicy.feedbackRequest(
                        host.deviceId(), current.assignment, candidate, comment, requestId("feedback"));
                releaseClient(gateway, token).feedback(body);
                main.post(() -> {
                    if (!active(operationGeneration)) return;
                    feedbackInput.setText("");
                    render("Feedback recorded for " + candidate.releaseId + ".", MoaColors.OK);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (active(operationGeneration)) render(
                            "Feedback was not recorded. Your text remains here.", MoaColors.WARN);
                });
            }
        }, "moa-release-feedback").start();
    }

    private MoaReleaseSelectionPolicy.Candidate candidateForAssignment(
            MoaReleaseSelectionPolicy.View current) {
        if (current == null || current.assignment == null) return null;
        for (MoaReleaseSelectionPolicy.Candidate item : current.candidates) {
            if (current.assignment.releaseId.equals(item.releaseId)
                    && current.assignment.channel.equals(item.channel)) return item;
        }
        return "stable".equals(current.assignment.channel) ? current.stable : current.preview;
    }

    private boolean exactRunningSelection() {
        return MoaReleaseSelectionPolicy.exactRunningSelection(
                view, selected, localInstalledSha256);
    }

    private boolean active(int expectedGeneration) {
        return !disposed && generation == expectedGeneration && !activity.isFinishing();
    }

    private MoaReleaseControlClient releaseClient(String gateway, String token) {
        return new MoaReleaseControlClient(
                gateway, token, host.deviceId(), new MoaDeviceCredentialStore(activity));
    }

    private void renderCandidate(TextView target, MoaReleaseSelectionPolicy.Candidate candidate) {
        if (candidate == null) {
            target.setText("Not available");
            target.setTextColor(MoaColors.GOLD);
            return;
        }
        String compatibility = candidate.compatible ? "compatible"
                : (candidate.compatibilityReason.isEmpty()
                ? "incompatible" : candidate.compatibilityReason);
        target.setText(candidate.label() + " · " + compatibility);
        target.setTextColor(candidate.compatible ? MoaColors.OK : MoaColors.WARN);
    }

    private void buttons(boolean stable, boolean preview) {
        if (stableButton != null) {
            stableButton.setEnabled(stable);
            stableButton.setAlpha(stable ? 1f : 0.5f);
        }
        if (previewButton != null) {
            previewButton.setEnabled(preview);
            previewButton.setAlpha(preview ? 1f : 0.5f);
        }
    }

    private void status(String message, int color) {
        if (actionStatus != null) {
            actionStatus.setText(message);
            actionStatus.setTextColor(color);
        }
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(MoaDrawables.rounded(
                MoaColors.RAISED, dp(20), MoaColors.RAISED_BORDER, dp(1)));
        card.setElevation(dp(6));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(14);
        card.setLayoutParams(params);
        return card;
    }

    private TextView statRow(LinearLayout parent, String name, String value) {
        LinearLayout row = new LinearLayout(activity);
        row.setPadding(0, dp(6), 0, dp(6));
        row.addView(text(name, MoaColors.PAPER, 14, false));
        TextView result = text(value, MoaColors.GOLD, 14, true);
        result.setGravity(Gravity.END);
        LinearLayout.LayoutParams params =
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.leftMargin = dp(12);
        row.addView(result, params);
        parent.addView(row);
        return result;
    }

    private EditText input(String hint) {
        EditText input = new EditText(activity);
        input.setHint(hint);
        input.setHintTextColor(0x72EEF8E8);
        input.setTextColor(MoaColors.PAPER);
        input.setTextSize(15);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setSingleLine(false);
        input.setMinLines(3);
        input.setMaxLines(8);
        input.setBackground(MoaDrawables.rounded(
                0x14FFFFFF, dp(14), MoaColors.RAISED_BORDER, dp(1)));
        input.setPadding(dp(12), dp(8), dp(12), dp(8));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(10);
        input.setLayoutParams(params);
        return input;
    }

    private Button primary(String label) {
        Button button = button(label);
        button.setTextColor(MoaColors.INK);
        button.setBackground(MoaDrawables.horizontalGradient(
                MoaColors.GOLD, 0xFFFFF1A6, dp(16)));
        return button;
    }

    private Button secondary(String label) {
        Button button = button(label);
        button.setTextColor(MoaColors.PAPER);
        button.setBackground(MoaDrawables.rounded(
                0x14FFFFFF, dp(16), MoaColors.RAISED_BORDER, dp(1)));
        return button;
    }

    private Button button(String label) {
        Button button = new Button(activity);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setMinHeight(dp(52));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12);
        button.setLayoutParams(params);
        return button;
    }

    private TextView text(String value, int color, int size, boolean bold) {
        TextView text = new TextView(activity);
        text.setText(value);
        text.setTextColor(color);
        text.setTextSize(size);
        if (bold) text.setTypeface(Typeface.DEFAULT_BOLD);
        return text;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private String requestId(String prefix) {
        return prefix + "-" + UUID.randomUUID();
    }

    private String capitalize(String value) {
        return Character.toUpperCase(value.charAt(0)) + value.substring(1);
    }
}

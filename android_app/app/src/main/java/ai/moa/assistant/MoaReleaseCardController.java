package ai.moa.assistant;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.UUID;
import java.util.ArrayList;
import java.util.List;
import java.time.Instant;

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
    private Button createFixButton;
    private Button videoButton;
    private Button cancelVideoButton;
    private EditText feedbackInput;
    private TextView modificationStatus;
    private TextView modificationIdentities;
    private TextView videoStatus;
    private EditText searchInput;
    private LinearLayout candidateColumn;
    private TextView candidateCount;
    private final ArrayList<MoaReleaseSelectionPolicy.Candidate> catalog = new ArrayList<>();
    private String exactBundleFromIntent = "";
    private int generation;
    private MoaReleaseSelectionPolicy.View view;
    private MoaReleaseSelectionPolicy.Candidate selected;
    private String pinnedGatewayUrl = "";
    private String pinnedGatewayToken = "";
    private String localInstalledSha256 = "";
    private boolean disposed;
    private View cardRoot;
    private final MoaModificationStatusStore modificationStore;
    private final MoaCreateFixAuthorizationStore createFixAuthorizationStore;
    private MoaModificationRequestPolicy.Status latestModification;
    private String recordedFeedbackId = "";
    private String recordedFeedbackText = "";
    private MoaReleaseSelectionPolicy.Assignment recordedFeedbackAssignment;
    private MoaReleaseSelectionPolicy.Candidate recordedFeedbackCandidate;
    private MoaVideoNoteState videoNote = MoaVideoNoteState.idle();

    MoaReleaseCardController(Activity activity, Host host) {
        this.activity = activity;
        this.host = host;
        this.modificationStore = new MoaModificationStatusStore(activity);
        this.createFixAuthorizationStore = new MoaCreateFixAuthorizationStore(activity);
        this.latestModification = modificationStore.load();
    }

    View createView() {
        LinearLayout card = card();
        cardRoot = card;
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

        TextView browseTitle = text("Test candidates", MoaColors.PAPER, 16, true);
        browseTitle.setPadding(0, dp(18), 0, dp(4));
        card.addView(browseTitle);
        candidateCount = text("Loading candidates…", MoaColors.MUTED, 13, false);
        card.addView(candidateCount);
        searchInput = input("Search by feature, version, or bundle");
        searchInput.setMinLines(1);
        searchInput.setMaxLines(1);
        searchInput.setSingleLine(true);
        searchInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { renderCatalog(); }
            @Override public void afterTextChanged(Editable s) { }
        });
        card.addView(searchInput);
        candidateColumn = new LinearLayout(activity);
        candidateColumn.setOrientation(LinearLayout.VERTICAL);
        card.addView(candidateColumn);

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

        createFixButton = primary("Create fix from recorded feedback");
        createFixButton.setEnabled(false);
        createFixButton.setOnClickListener(v -> createFix());
        card.addView(createFixButton);

        TextView fixHint = text(
                "Submitting feedback records inert evidence. Create fix is the separate action that authorizes implementation.",
                MoaColors.MUTED, 12, false);
        fixHint.setPadding(0, dp(6), 0, dp(4));
        card.addView(fixHint);
        modificationStatus = statRow(card, "Fix status", "None");
        modificationIdentities = text("No implementation request has been created.", MoaColors.MUTED, 12, false);
        card.addView(modificationIdentities);
        renderModification(latestModification);

        TextView videoTitle = text("Video evidence", MoaColors.PAPER, 16, true);
        videoTitle.setPadding(0, dp(18), 0, dp(4));
        card.addView(videoTitle);
        videoStatus = text("No video requested or captured.", MoaColors.MUTED, 13, false);
        card.addView(videoStatus);
        videoButton = secondary("Request video note");
        videoButton.setOnClickListener(v -> requestVideoNote());
        card.addView(videoButton);
        cancelVideoButton = secondary("Cancel video note");
        cancelVideoButton.setVisibility(View.GONE);
        cancelVideoButton.setOnClickListener(v -> cancelVideoNote());
        card.addView(cancelVideoButton);
        return card;
    }

    View anchor() {
        return cardRoot;
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
                ArrayList<MoaReleaseSelectionPolicy.Candidate> loaded = new ArrayList<>();
                String cursor = "";
                do {
                    MoaReleaseSelectionPolicy.CatalogPage page =
                            MoaReleaseSelectionPolicy.parseCatalog(client.candidates(cursor, 50));
                    loaded.addAll(page.candidates);
                    cursor = page.nextCursor;
                } while (!cursor.isEmpty() && loaded.size() < 300);
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
                    catalog.clear();
                    catalog.addAll(loaded);
                    selected = candidateForAssignment(resolved);
                    render("Release control ready.", MoaColors.OK);
                    renderCatalog();
                    refreshModificationStatus();
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
        catalog.clear();
        buttons(false, false);
        if (assignmentStatus != null) assignmentStatus.setText("Unavailable");
        if (stableStatus != null) stableStatus.setText("Unavailable");
        if (previewStatus != null) previewStatus.setText("Unavailable");
        if (installButton != null) installButton.setVisibility(View.GONE);
        if (feedbackButton != null) feedbackButton.setEnabled(false);
        if (createFixButton != null) createFixButton.setEnabled(false);
        status(message, MoaColors.WARN);
        renderCatalog();
    }

    void openCandidate(String bundleId) {
        exactBundleFromIntent = bundleId == null ? "" : bundleId.trim();
        if (searchInput != null) searchInput.setText(exactBundleFromIntent);
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
        createFixButton.setEnabled(bound && recordedFeedbackMatchesCurrent());
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

    private void selectExact(MoaReleaseSelectionPolicy.Candidate candidate) {
        MoaReleaseSelectionPolicy.View current = view;
        if (current == null || candidate == null || !candidate.compatible) {
            render("That candidate is not ready for this phone.", MoaColors.WARN);
            return;
        }
        status("Selecting " + candidate.humanLabel() + "…", MoaColors.GOLD);
        int operationGeneration = ++generation;
        String gateway = pinnedGatewayUrl;
        String token = pinnedGatewayToken;
        new Thread(() -> {
            try {
                long sequence = current.assignment == null ? 0L : current.assignment.sequence;
                JSONObject body = MoaReleaseSelectionPolicy.exactCandidateRequest(
                        host.deviceId(), candidate, sequence, requestId("candidate"));
                MoaReleaseControlClient client = releaseClient(gateway, token);
                JSONObject response = client.selectCandidate(body);
                MoaReleaseSelectionPolicy.Candidate offered =
                        MoaReleaseSelectionPolicy.selectedCandidate(response, "candidate");
                MoaReleaseSelectionPolicy.Assignment assignment =
                        MoaReleaseSelectionPolicy.assignmentFromResponse(response);
                main.post(() -> {
                    if (!active(operationGeneration)) return;
                    selected = offered.artifact == null ? candidate : new MoaReleaseSelectionPolicy.Candidate(
                            candidate.releaseId, candidate.bundleId, "candidate", candidate.sourceRef,
                            true, "", offered.artifact, candidate.createdAt, candidate.lineageKind,
                            candidate.seriesParentBundleId, candidate.parallelParentBundleIds);
                    view = new MoaReleaseSelectionPolicy.View(
                            current.reportedInstalledReleaseId, current.reportedInstalledSha256,
                            assignment, current.stable, current.preview,
                            current.hasLastKnownGood, current.candidates);
                    render(candidate.humanLabel() + " selected — not installed.", MoaColors.GOLD);
                    renderCatalog();
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (active(operationGeneration)) render(
                            "Selection changed or failed. Refresh before trying again; nothing was installed.",
                            MoaColors.WARN);
                });
            }
        }, "moa-release-candidate-select").start();
    }

    private void renderCatalog() {
        if (candidateColumn == null || candidateCount == null) return;
        candidateColumn.removeAllViews();
        String selectedBundle = view == null || view.assignment == null ? "" : view.assignment.bundleId;
        String query = searchInput == null ? exactBundleFromIntent : searchInput.getText().toString();
        List<MoaReleaseSelectionPolicy.Candidate> visible =
                MoaReleaseSelectionPolicy.rank(catalog, query, selectedBundle, localInstalledSha256);
        candidateCount.setText(visible.size() + " of " + catalog.size()
                + " published candidates · selection does not install");
        if (visible.isEmpty()) {
            TextView empty = text(catalog.isEmpty() ? "No published Android candidates yet."
                    : "No candidate matches that search.", MoaColors.MUTED, 14, false);
            empty.setPadding(0, dp(12), 0, dp(4));
            candidateColumn.addView(empty);
            return;
        }
        for (MoaReleaseSelectionPolicy.Candidate candidate : visible) {
            LinearLayout row = card();
            row.setElevation(0);
            TextView title = text(candidate.humanLabel(), MoaColors.PAPER, 15, true);
            row.addView(title);
            String state = MoaReleaseSelectionPolicy.coarseState(
                    candidate, selectedBundle, localInstalledSha256);
            TextView detail = text(candidate.summary() + "\n" + candidate.relationLabel()
                    + " · Android · published/" + (candidate.compatible ? "ready" : "blocked")
                    + " · " + state, candidate.compatible ? MoaColors.MUTED : MoaColors.WARN, 13, false);
            detail.setPadding(0, dp(5), 0, 0);
            row.addView(detail);
            Button choose = secondary(candidate.bundleId.equals(selectedBundle) ? "Selected" : "Select exact candidate");
            choose.setEnabled(candidate.compatible && !candidate.bundleId.equals(selectedBundle));
            choose.setOnClickListener(v -> selectExact(candidate));
            row.addView(choose);
            candidateColumn.addView(row);
        }
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
                JSONObject response = releaseClient(gateway, token).feedback(body);
                String feedbackId = MoaModificationRequestPolicy.parseFeedbackId(response);
                main.post(() -> {
                    if (!active(operationGeneration)) return;
                    recordedFeedbackId = feedbackId;
                    recordedFeedbackText = comment;
                    recordedFeedbackAssignment = current.assignment;
                    recordedFeedbackCandidate = candidate;
                    render("Feedback recorded for " + candidate.releaseId
                            + ". No implementation started.", MoaColors.OK);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (active(operationGeneration)) render(
                            "Feedback was not recorded. Your text remains here.", MoaColors.WARN);
                });
            }
        }, "moa-release-feedback").start();
    }

    private void createFix() {
        if (recordedFeedbackId.isEmpty() || recordedFeedbackAssignment == null
                || recordedFeedbackCandidate == null || !exactRunningSelection()
                || selected == null
                || !selected.releaseId.equals(recordedFeedbackCandidate.releaseId)
                || !selected.bundleId.equals(recordedFeedbackCandidate.bundleId)
                || !view.assignment.assignmentId.equals(recordedFeedbackAssignment.assignmentId)) {
            render("Record feedback for the exact running release before creating a fix.", MoaColors.WARN);
            return;
        }
        createFixButton.setEnabled(false);
        int operationGeneration = ++generation;
        String gateway = pinnedGatewayUrl;
        String token = pinnedGatewayToken;
        final MoaCreateFixAuthorization authorization;
        try {
            authorization = MoaCreateFixAuthorization.authorizeExplicitly(
                    recordedFeedbackId, createFixAuthorizationStore.load(), Instant.now());
            createFixAuthorizationStore.save(authorization);
        } catch (Exception error) {
            createFixButton.setEnabled(true);
            render("Fix authorization could not be saved. No request was sent.", MoaColors.WARN);
            return;
        }
        new Thread(() -> {
            try {
                JSONObject body = MoaModificationRequestPolicy.createRequest(
                        recordedFeedbackId, host.deviceId(), recordedFeedbackAssignment,
                        recordedFeedbackCandidate, recordedFeedbackText, authorization);
                JSONObject response = releaseClient(gateway, token).createModificationRequest(body);
                MoaModificationRequestPolicy.Status parsed =
                        MoaModificationRequestPolicy.parseCreateResponse(response);
                modificationStore.save(parsed);
                main.post(() -> {
                    if (!active(operationGeneration)) return;
                    latestModification = parsed;
                    renderModification(parsed);
                    render("Fix request created. Implementation is now explicitly authorized.", MoaColors.OK);
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (!active(operationGeneration)) return;
                    createFixButton.setEnabled(true);
                    render("Fix request was not created. Recorded feedback remains inert.", MoaColors.WARN);
                });
            }
        }, "moa-create-fix").start();
    }

    private void refreshModificationStatus() {
        MoaModificationRequestPolicy.Status current = latestModification;
        if (current == null || current.requestId.isEmpty()) return;
        String gateway = pinnedGatewayUrl;
        String token = pinnedGatewayToken;
        int expectedGeneration = generation;
        new Thread(() -> {
            try {
                JSONObject response = releaseClient(gateway, token).modificationRequest(current.requestId);
                MoaModificationRequestPolicy.Status parsed =
                        MoaModificationRequestPolicy.parseStatusResponse(response, current.requestId);
                modificationStore.save(parsed);
                main.post(() -> {
                    if (!active(expectedGeneration)) return;
                    latestModification = parsed;
                    renderModification(parsed);
                });
            } catch (Exception ignored) {
                // Keep rendering the last durable truthful projection; transport failure is not a state change.
            }
        }, "moa-modification-status").start();
    }

    private void renderModification(MoaModificationRequestPolicy.Status status) {
        if (modificationStatus == null || modificationIdentities == null) return;
        if (status == null) {
            modificationStatus.setText("None");
            modificationIdentities.setText("No implementation request has been created.");
            return;
        }
        String label = status.state;
        if (!status.blockingReason.isEmpty()) label += " · " + status.blockingReason;
        modificationStatus.setText(label);
        modificationStatus.setTextColor(("blocked".equals(status.state) || "failed".equals(status.state)
                || "reclaimable".equals(status.state)) ? MoaColors.WARN : MoaColors.OK);
        modificationIdentities.setText("Request " + status.requestId + "\nIntent " + value(status.intentId)
                + " · Task " + value(status.taskId) + "\nRun " + value(status.runId)
                + " · Owner " + value(status.ownerId) + "\nQA " + value(status.qaId)
                + " · Artifact " + value(status.artifactId) + " · Preview " + value(status.previewId));
    }

    private void requestVideoNote() {
        if (!exactRunningSelection() || view == null || view.assignment == null || selected == null
                || selected.artifact == null) {
            videoStatus.setText("Video evidence requires the exact running release.");
            videoStatus.setTextColor(MoaColors.WARN);
            return;
        }
        try {
            videoNote = videoNote.request(new MoaVideoNoteState.Binding(
                    view.assignment.assignmentId, selected.releaseId, selected.bundleId,
                    selected.artifact.sha256));
            videoStatus.setText("Video capture requested for this exact release. Capture is not active; no artifact exists.");
            videoStatus.setTextColor(MoaColors.GOLD);
            videoButton.setEnabled(false);
            cancelVideoButton.setVisibility(View.VISIBLE);
        } catch (Exception error) {
            videoStatus.setText("Video capture request could not be prepared.");
            videoStatus.setTextColor(MoaColors.WARN);
        }
    }

    private void cancelVideoNote() {
        try {
            videoNote = videoNote.cancel();
            videoStatus.setText("Video note cancelled. No captured or uploaded artifact exists.");
            videoStatus.setTextColor(MoaColors.MUTED);
            videoButton.setEnabled(true);
            cancelVideoButton.setVisibility(View.GONE);
        } catch (Exception ignored) { }
    }

    private static String value(String value) {
        return value == null || value.isEmpty() ? "pending" : value;
    }

    private MoaReleaseSelectionPolicy.Candidate candidateForAssignment(
            MoaReleaseSelectionPolicy.View current) {
        if (current == null || current.assignment == null) return null;
        for (MoaReleaseSelectionPolicy.Candidate item : catalog) {
            if (current.assignment.bundleId.equals(item.bundleId)) return item;
        }
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

    private boolean recordedFeedbackMatchesCurrent() {
        return !recordedFeedbackId.isEmpty() && view != null && view.assignment != null
                && selected != null && recordedFeedbackAssignment != null
                && recordedFeedbackCandidate != null
                && selected.releaseId.equals(recordedFeedbackCandidate.releaseId)
                && selected.bundleId.equals(recordedFeedbackCandidate.bundleId)
                && view.assignment.assignmentId.equals(recordedFeedbackAssignment.assignmentId);
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

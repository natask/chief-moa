package ai.moa.assistant;

import android.Manifest;
import android.app.SearchManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.provider.ContactsContract;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.security.MessageDigest;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

final class MoaActionBroker {
    private static final String RISK_READ_ONLY = "read_only";
    private static final String RISK_NAVIGATION = "navigation";
    private static final String RISK_EXTERNAL_SIDE_EFFECT = "external_side_effect";
    private static final String APPROVAL_IMPLICIT = "implicit_user_command";
    private static final String APPROVAL_TARGET_APP_CONFIRMATION = "target_app_confirmation";
    private static final String APPROVAL_LOCAL_CONFIRMATION = "local_confirmation";
    private static final String MEDIA_STORE_AUTHORITY = "ai.moa.assistant.media-store";
    private static final Map<String, Capability> CAPABILITIES = createCapabilityManifest();

    private final Context context;
    private final MoaMediaSessionController mediaSessions;
    private final MoaMediaSpotStore mediaSpots;
    private final MoaMediaDeleteJournal mediaDeletes;
    private final MoaActionApprovalController approvals = new MoaActionApprovalController();
    private YoutubePlaylistExecutor youtubePlaylistExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, CompletableFuture<String>> mediaSyncs = new ConcurrentHashMap<>();

    MoaActionBroker(Context context) {
        this.context = context.getApplicationContext();
        mediaSessions = new MoaMediaSessionController(this.context);
        mediaSpots = new MoaMediaSpotStore(this.context);
        mediaDeletes = new MoaMediaDeleteJournal(this.context);
        youtubePlaylistExecutor = this::executeYoutubePlaylist;
        retryPendingMediaSyncs();
        retryPendingMediaDeletes();
    }

    void setYoutubePlaylistExecutor(YoutubePlaylistExecutor executor) {
        youtubePlaylistExecutor = executor;
    }

    LocalActionResult tryHandleLocalCommand(String text) {
        String trimmed = safe(text);
        String lower = trimmed.toLowerCase(Locale.US);

        if (lower.equals("/screen")) {
            Capability capability = CAPABILITIES.get("screen.summary");
            if (!MoaAccessibilityService.isRunning()) {
                return LocalActionResult.handled("Screen access is not running. Open AG and enable screen access in Android accessibility settings.");
            }
            String summary = MoaAccessibilityService.currentScreenSummary();
            if (summary.isEmpty()) {
                recordReceipt(capability, "", false, "No visible screen text was available.");
                return LocalActionResult.handled("Screen access is running, but I could not read visible text from the active window.");
            }
            recordReceipt(capability, "", true, "Screen summary returned.");
            return LocalActionResult.handled("Current screen: " + summary);
        }

        if (lower.startsWith("/tap ")) {
            Capability capability = CAPABILITIES.get("screen.tap_text");
            String label = trimmed.substring("/tap ".length()).trim();
            if (label.isEmpty()) {
                return LocalActionResult.handled("Tell me the visible label to tap, like /tap Allow.");
            }
            if (!MoaAccessibilityService.isRunning()) {
                recordReceipt(capability, label, false, "Screen access is not running.");
                return LocalActionResult.handled("Screen access is not running. Enable it before using /tap.");
            }
            String expectedPackage = currentPackageName();
            MoaAccessibilityService.TapResult tapResult = MoaAccessibilityService.clickByText(label, expectedPackage);
            if (tapResult == MoaAccessibilityService.TapResult.CLICKED) {
                recordReceipt(capability, label, true, "Tapped visible label.");
                return LocalActionResult.handled("Tapped \"" + label + "\".");
            }
            if (tapResult == MoaAccessibilityService.TapResult.STALE_TARGET) {
                recordReceipt(capability, label, false, "Active app changed before execution.");
                return LocalActionResult.handled("The active app changed before I could tap. Please try again on the intended screen.");
            }
            recordReceipt(capability, label, false, "No visible clickable match.");
            return LocalActionResult.handled("I could not find a visible clickable item matching \"" + label + "\".");
        }

        if (lower.equals("/back")) {
            Capability capability = CAPABILITIES.get("system.back");
            if (!MoaAccessibilityService.isRunning()) {
                recordReceipt(capability, "", false, "Screen access is not running.");
                return LocalActionResult.handled("Screen access is not running. Enable it before using /back.");
            }
            boolean success = MoaAccessibilityService.performBack();
            recordReceipt(capability, "", success, success ? "Pressed back." : "Back action failed.");
            return LocalActionResult.handled(success ? "Pressed back." : "I could not press back from here.");
        }

        if (lower.equals("/home")) {
            Capability capability = CAPABILITIES.get("system.home");
            if (!MoaAccessibilityService.isRunning()) {
                recordReceipt(capability, "", false, "Screen access is not running.");
                return LocalActionResult.handled("Screen access is not running. Enable it before using /home.");
            }
            boolean success = MoaAccessibilityService.performHome();
            recordReceipt(capability, "", success, success ? "Pressed home." : "Home action failed.");
            return LocalActionResult.handled(success ? "Pressed home." : "I could not press home from here.");
        }

        if (MoaControlCenterCommand.isExplicitRequest(trimmed)) {
            return openControlCenter();
        }

        if (isAppListCommand(trimmed)) {
            return listLauncherAppsForCommand();
        }

        String appTarget = openAppTarget(trimmed);
        if (!appTarget.isEmpty()) {
            return openLauncherApp(appTarget);
        }

        return LocalActionResult.notHandled();
    }

    private LocalActionResult openControlCenter() {
        Capability capability = CAPABILITIES.get("ui.control_center");
        Intent intent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            recordReceipt(capability, "control_center", true, "Opened AG control center.");
            return LocalActionResult.handled("Opened the AG control center.");
        } catch (RuntimeException error) {
            recordReceipt(capability, "control_center", false, "Control center launch failed.");
            return LocalActionResult.handled("I could not open the AG control center.");
        }
    }

    ToolExecutionResult executeToolRequest(String tool, JSONObject input) {
        return executeToolRequest("", tool, input, null);
    }

    ToolExecutionResult executeToolRequest(String requestId, String tool, JSONObject input) {
        return executeToolRequest(requestId, tool, input, null);
    }

    ToolExecutionResult executeToolRequest(
            String requestId, String tool, JSONObject input, ToolResultCallback callback) {
        String name = safe(tool).toLowerCase(Locale.US);
        JSONObject args = input == null ? new JSONObject() : input;

        if ("screen.summary".equals(name)) {
            Capability capability = CAPABILITIES.get("screen.summary");
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            String summary = MoaAccessibilityService.currentScreenSummary();
            if (summary.isEmpty()) {
                JSONObject receipt = recordReceipt(capability, "", false, "No visible screen text was available.");
                return ToolExecutionResult.done(false, "No visible screen text was available.", receipt);
            }
            JSONObject receipt = recordReceipt(capability, "", true, "Screen summary returned.");
            return ToolExecutionResult.done(true, "Current screen: " + summary, receipt);
        }

        if ("screen.tap_text".equals(name)) {
            Capability capability = CAPABILITIES.get("screen.tap_text");
            String label = safe(args.optString("text", args.optString("label", args.optString("target", ""))));
            if (label.isEmpty()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Visible label is required.");
                return ToolExecutionResult.done(false, "Visible label is required.", receipt);
            }
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, label, false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            String expectedPackage = expectedPackage(args);
            if (expectedPackage.isEmpty()) {
                JSONObject receipt = recordReceipt(capability, label, false, "Expected package is required for a screen-bound action.");
                return ToolExecutionResult.done(false, "expected_package is required for screen.tap_text.", receipt);
            }
            MoaAccessibilityService.TapResult tapResult = MoaAccessibilityService.clickByText(label, expectedPackage);
            if (tapResult == MoaAccessibilityService.TapResult.STALE_TARGET) {
                JSONObject receipt = recordReceipt(capability, label, false, "Active app no longer matches expected package.");
                return ToolExecutionResult.done(false, "The active app changed; screen.tap_text was not executed.", receipt);
            }
            boolean clicked = tapResult == MoaAccessibilityService.TapResult.CLICKED;
            String result = clicked ? "Tapped visible label." : "No visible clickable match.";
            JSONObject receipt = recordReceipt(capability, label, clicked, result);
            return ToolExecutionResult.done(clicked, clicked ? "Tapped \"" + label + "\"." : "No visible clickable item matched \"" + label + "\".", receipt);
        }

        if ("system.back".equals(name)) {
            Capability capability = CAPABILITIES.get("system.back");
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            boolean success = MoaAccessibilityService.performBack();
            JSONObject receipt = recordReceipt(capability, "", success, success ? "Pressed back." : "Back action failed.");
            return ToolExecutionResult.done(success, success ? "Pressed back." : "Back action failed.", receipt);
        }

        if ("system.home".equals(name)) {
            Capability capability = CAPABILITIES.get("system.home");
            if (!MoaAccessibilityService.isRunning()) {
                JSONObject receipt = recordReceipt(capability, "", false, "Screen access is not running.");
                return ToolExecutionResult.done(false, "Screen access is not running.", receipt);
            }
            boolean success = MoaAccessibilityService.performHome();
            JSONObject receipt = recordReceipt(capability, "", success, success ? "Pressed home." : "Home action failed.");
            return ToolExecutionResult.done(success, success ? "Pressed home." : "Home action failed.", receipt);
        }

        if ("app.launch".equals(name)) {
            return openLauncherAppForTool(args);
        }

        if ("app.list".equals(name)) {
            return listLauncherAppsForTool(args);
        }

        if ("email.compose".equals(name)) {
            return composeEmailDraft(args);
        }

        if ("sms.compose".equals(name)) {
            return composeSmsDraft(args);
        }

        if ("url.open".equals(name)) {
            return openUrlForTool(args);
        }

        if ("phone.dial".equals(name)) {
            return dialNumberForTool(args);
        }

        if ("contact.open".equals(name)) {
            return openContactForTool(args);
        }

        if ("media.open".equals(name)) {
            return openMediaForTool(requestId, args, callback);
        }

        if ("media.control".equals(name)) {
            return controlMediaForTool(args);
        }

        if ("media.bookmark".equals(name)) {
            return bookmarkMediaForTool(requestId, args, callback);
        }

        if ("media.playlist".equals(name)) {
            return preparePlaylistTool(requestId, args);
        }

        return ToolExecutionResult.done(false, "Unsupported local tool: " + name + ".", null);
    }

    JSONObject screenSnapshot() {
        return MoaAccessibilityService.currentScreenSnapshot();
    }

    JSONObject activeAppDescriptor() {
        return MoaAccessibilityService.currentActiveAppDescriptor();
    }

    JSONArray executionAdapters() {
        return MoaAccessibilityService.currentExecutionAdapters();
    }

    JSONObject mediaSessionDescriptor() {
        MoaMediaSessionController.Snapshot snapshot = mediaSessions.currentSnapshot(
                MoaPrefs.preferredYoutubePackage(context));
        JSONObject descriptor = snapshot == null ? new JSONObject() : snapshot.toJson();
        try {
            descriptor.put("notification_access", mediaSessions.hasNotificationAccess());
            descriptor.put("preferred_package", MoaPrefs.preferredYoutubePackage(context));
        } catch (JSONException ignored) {
        }
        return descriptor;
    }

    String currentScreenSummary() {
        return MoaAccessibilityService.currentScreenSummary();
    }

    void putScreenContext(JSONObject body) throws JSONException {
        JSONObject screen = screenSnapshot();
        if (screen != null) {
            body.put("screen", screen);
        }
    }

    static String expectedPackage(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("expected_package", args.optString("expectedPackage", "")));
    }

    private static String currentPackageName() {
        return safe(MoaAccessibilityService.freshActivePackage());
    }

    String promptWithScreenContext(String prompt) {
        String summary = MoaAccessibilityService.currentScreenSummary();
        if (summary.isEmpty()) {
            return prompt;
        }
        return prompt + "\n\nCurrent Android screen context:\n" + summary;
    }

    boolean isScreenAccessEnabled() {
        return MoaAccessibilityService.isEnabled(context);
    }

    boolean isScreenAccessRunning() {
        return MoaAccessibilityService.isRunning();
    }

    JSONObject capabilityManifest() {
        JSONObject manifest = new JSONObject();
        for (Capability capability : CAPABILITIES.values()) {
            try {
                JSONObject item = new JSONObject();
                item.put("tool", capability.tool);
                item.put("risk", capability.risk);
                item.put("approval", capability.approval);
                manifest.put(capability.tool, item);
            } catch (JSONException ignored) {
            }
        }
        return manifest;
    }

    JSONArray localToolManifest() throws JSONException {
        JSONArray manifest = new JSONArray();
        List<String> tools = new ArrayList<>(CAPABILITIES.keySet());
        Collections.sort(tools);
        for (String tool : tools) {
            Capability capability = CAPABILITIES.get(tool);
            if ("blocked".equals(capability.approval)
                    || "external.side_effect".equals(capability.tool)) {
                continue;
            }
            JSONObject item = new JSONObject()
                    .put("tool", capability.tool)
                    .put("risk", capability.risk)
                    .put("approval", capability.approval);
            if ("screen.tap_text".equals(tool)) {
                item.put("required_input", new JSONArray().put("expected_package"));
            } else if ("media.control".equals(tool)) {
                item.put("required_input", new JSONArray().put("action"));
            } else if ("media.playlist".equals(tool)) {
                item.put("required_input", new JSONArray().put("operation"));
            }
            manifest.put(item);
        }
        return manifest;
    }

    boolean rejectsModelProposal(JSONObject proposal) {
        if (proposal == null) {
            return true;
        }
        String tool = safe(proposal.optString("tool", proposal.optString("name", "")));
        Capability capability = CAPABILITIES.get(tool);
        return capability == null || "blocked".equals(capability.approval);
    }

    private JSONObject recordReceipt(Capability capability, String target, boolean success, String result) {
        if (capability == null) {
            return null;
        }
        return MoaActionReceiptStore.record(context, capability.tool, capability.risk, capability.approval, target, success, result);
    }

    private LocalActionResult listLauncherAppsForCommand() {
        return LocalActionResult.handled(listLauncherAppsForTool(new JSONObject()).reply);
    }

    private ToolExecutionResult openMediaForTool(
            String requestId, JSONObject args, ToolResultCallback callback) {
        Capability capability = CAPABILITIES.get("media.open");
        String packageName = resolveMediaOpenYoutubePackage(args);
        if (packageName.isEmpty()) {
            return mediaFailure(capability, "youtube", "The preferred YouTube app is not installed.");
        }
        String videoId = MoaYoutubeUiPolicy.extractVideoId(args.optString(
                "video_id", args.optString("url", args.optString("canonical_url", ""))));
        long positionMs = mediaPositionMs(args);
        if (!videoId.isEmpty()) {
            return openYoutubeVideo(capability, packageName, videoId, positionMs);
        }
        String query = safe(args.optString("query", args.optString("search", args.optString("title", ""))));
        if (query.isEmpty()) {
            Intent launch = context.getPackageManager().getLaunchIntentForPackage(packageName);
            return launch == null
                    ? mediaFailure(capability, packageName, "The selected YouTube app has no launch activity.")
                    : startMediaIntent(capability, packageName, launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            "Opened " + packageName + "; no media selection or playback was verified.",
                            "selection_unverified", false);
        }
        MoaMediaSessionController.Snapshot snapshot = mediaSessions.currentSnapshot(packageName);
        if (hasSuppliedMediaBinding(args) && !matchesOptionalMediaBinding(args, snapshot)) {
            return mediaFailure(capability, packageName,
                    "The supplied media session binding is stale or unavailable.");
        }
        Intent search = new Intent(Intent.ACTION_SEARCH).setPackage(packageName)
                .putExtra(SearchManager.QUERY, query).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String channel = safe(args.optString("channel", ""));
        boolean handlerAvailable = search.resolveActivity(context.getPackageManager()) != null;
        if (!handlerAvailable) {
            return mediaOutcome(capability, packageName, false,
                    "The selected YouTube app cannot handle search.", "selection_unverified");
        }
        if (!MoaAccessibilityService.isRunning()
                || !approvedYoutubeAutomationPackage(packageName)) {
            return mediaOutcome(capability, packageName, false,
                    "Exact YouTube selection needs approved Screen access; no result was selected.",
                    "needs_accessibility");
        }
        if (shouldSelectYoutubeSearch(query, callback != null, true, true)) {
            try {
                context.startActivity(search);
            } catch (RuntimeException error) {
                return mediaFailure(capability, packageName, "The selected YouTube app could not be opened.");
            }
            String operationId = safe(requestId).isEmpty() ? "media_" + UUID.randomUUID() : requestId;
            mainHandler.postDelayed(() -> startYoutubeSearchSelection(
                    operationId, packageName, query, channel, callback), 700L);
            return ToolExecutionResult.pending("Opened YouTube search and waiting for the exact result.");
        }
        return mediaOutcome(capability, packageName, false,
                "Exact YouTube selection could not be verified without a result callback.",
                "selection_unverified");
    }

    private void startYoutubeSearchSelection(
            String operationId, String packageName, String title, String channel,
            ToolResultCallback callback) {
        MoaYoutubeAccessibilityExecutor.Request request = new MoaYoutubeAccessibilityExecutor.Request(
                operationId, MoaYoutubeAccessibilityExecutor.Kind.OPEN_SEARCH_RESULT,
                packageName, MoaAccessibilityService.currentActiveWindowId(),
                title, channel, "", "",
                System.currentTimeMillis() + MoaYoutubeUiPolicy.MAX_OPERATION_LIFETIME_MS);
        MoaAccessibilityService.YoutubeStartResult started =
                MoaAccessibilityService.executeYoutubeOperation(request, result -> {
                    boolean success = result.outcome == MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE;
                    String summary = success ? "Selected the unique YouTube result; playback was not verified."
                            : "YouTube search stopped: " + result.reason + ".";
                    callback.onResult(success
                            ? mediaOutcome(CAPABILITIES.get("media.open"), packageName, true,
                                    summary, "selection_verified")
                            : mediaOutcome(CAPABILITIES.get("media.open"), packageName, false,
                                    summary, "selection_unverified"));
                });
        if (started != MoaAccessibilityService.YoutubeStartResult.STARTED) {
            callback.onResult(mediaOutcome(CAPABILITIES.get("media.open"), packageName, false,
                    started == MoaAccessibilityService.YoutubeStartResult.BUSY
                            ? "Another YouTube operation is already running."
                            : "Screen access is unavailable for YouTube search selection.",
                    started == MoaAccessibilityService.YoutubeStartResult.BUSY
                            ? "selection_unverified" : "needs_accessibility"));
        }
    }

    static boolean shouldSelectYoutubeSearch(
            String query, boolean callbackAvailable, boolean approvedAdapter, boolean handlerAvailable) {
        return !safe(query).isEmpty() && callbackAvailable && approvedAdapter && handlerAvailable;
    }

    private ToolExecutionResult openYoutubeVideo(
            Capability capability, String packageName, String videoId, long positionMs) {
        Uri.Builder uri = Uri.parse(MoaMediaSpotStore.canonicalYouTubeWatchUri(videoId)).buildUpon();
        if (positionMs > 0L) {
            uri.appendQueryParameter("t", Math.max(0L, positionMs / 1000L) + "s");
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri.build()).setPackage(packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return startMediaIntent(capability, packageName, intent,
                "Sent YouTube video " + videoId + " to the selected app; playback was not verified.",
                "selection_unverified", false);
    }

    private ToolExecutionResult startMediaIntent(
            Capability capability, String packageName, Intent intent, String successReply,
            String outcome, boolean success) {
        if (intent.resolveActivity(context.getPackageManager()) == null) {
            return mediaFailure(capability, packageName, "The selected YouTube app cannot handle this request.");
        }
        try {
            context.startActivity(intent);
            return mediaOutcome(capability, packageName, success, successReply, outcome);
        } catch (RuntimeException error) {
            return mediaFailure(capability, packageName, "The selected YouTube app could not be opened.");
        }
    }

    private ToolExecutionResult controlMediaForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("media.control");
        MoaMediaSessionController.Snapshot snapshot = mediaSessions.currentSnapshot(
                resolveYoutubePackage(new JSONObject()));
        if (snapshot == null) {
            String reason = mediaSessions.hasNotificationAccess()
                    ? "No active YouTube media session is available."
                    : "Notification access is required for media control.";
            return mediaFailure(capability, "youtube", reason);
        }
        String packageName = snapshot.packageName;
        String fingerprint = snapshot.mediaFingerprint;
        if (!matchesOptionalMediaBinding(args, snapshot)) {
            return mediaFailure(capability, packageName,
                    "The supplied media session binding is stale.");
        }
        String operation = safe(args.optString("operation", args.optString("action", ""))).toLowerCase(Locale.US);
        MoaMediaSessionController.ControlResult result;
        switch (operation) {
            case "play": result = mediaSessions.play(packageName, fingerprint); break;
            case "pause": result = mediaSessions.pause(packageName, fingerprint); break;
            case "toggle": result = mediaSessions.toggle(packageName, fingerprint); break;
            case "stop": result = mediaSessions.stop(packageName, fingerprint); break;
            case "next": result = mediaSessions.next(packageName, fingerprint); break;
            case "previous": result = mediaSessions.previous(packageName, fingerprint); break;
            case "seek":
            case "seek_to":
                result = mediaSessions.seek(packageName, fingerprint, mediaPositionMs(args));
                break;
            case "seek_by":
                result = mediaSessions.seekBy(
                        packageName, fingerprint, args.optLong("offset_ms", 0L));
                break;
            default: return mediaFailure(capability, packageName, "Unsupported media control operation.");
        }
        String reason = result.executed() ? "Media control completed." : result.reason;
        return result.executed() ? mediaSuccess(capability, packageName, reason)
                : mediaFailure(capability, packageName, reason);
    }

    private ToolExecutionResult bookmarkMediaForTool(
            String requestId, JSONObject args, ToolResultCallback callback) {
        if (!mediaDeletes.healthy()) return mediaFailure(CAPABILITIES.get("media.bookmark"),
                "bookmark", "Bookmark recovery state is unavailable; no action was taken.");
        String operation = safe(args.optString("operation", args.optString("action", "remember")))
                .toLowerCase(Locale.US);
        if ("list".equals(operation)) return listMediaSpots(callback);
        if ("open".equals(operation)) return openMediaSpot(args, callback);
        if (!Set.of("remember", "save", "delete", "remove").contains(operation)) {
            return mediaFailure(CAPABILITIES.get("media.bookmark"), "bookmark", "Unsupported bookmark operation.");
        }
        if (safe(requestId).isEmpty()) {
            return mediaFailure(CAPABILITIES.get("media.bookmark"), "bookmark",
                    "A request id is required for bookmark changes.");
        }
        if (Set.of("delete", "remove").contains(operation) && findMediaSpot(args) == null) {
            return prepareRemoteDeleteConfirmation(requestId, operation, args, callback);
        }
        if (Set.of("remember", "save").contains(operation)) {
            String canonicalId = canonicalYoutubeVideoId(
                    args.optString("url", args.optString("canonical_url", "")));
            String requestedId = MoaYoutubeUiPolicy.extractVideoId(args.optString("video_id", ""));
            if (!canonicalId.isEmpty() && hasMediaPosition(args)) {
                materializeBookmarkIdentity(args, canonicalId, mediaPositionMs(args), "canonical_uri");
            } else {
                MoaMediaSessionController.Snapshot snapshot = mediaSessions.currentSnapshot(
                        resolveYoutubePackage(args));
                String snapshotId = snapshot == null ? "" : MoaYoutubeUiPolicy.extractVideoId(
                        !snapshot.mediaId.isEmpty() ? snapshot.mediaId : snapshot.mediaUri);
                if (!snapshotId.isEmpty() && (requestedId.isEmpty() || requestedId.equals(snapshotId))) {
                    materializeBookmarkIdentity(
                            args, snapshotId, snapshot.positionMs, "session_media_id");
                } else if (snapshot != null && callback != null
                        && approvedYoutubeAutomationPackage(snapshot.packageName)) {
                    return captureMediaSpotForConfirmation(requestId, args, snapshot, callback);
                } else {
                    return mediaFailure(CAPABILITIES.get("media.bookmark"), "bookmark",
                            "The exact current video ID could not be shown for approval.");
                }
            }
        }
        return bindBookmarkApproval(requestId, operation, args);
    }

    private ToolExecutionResult prepareRemoteDeleteConfirmation(
            String requestId, String operation, JSONObject args, ToolResultCallback callback) {
        String gatewayId = bookmarkIdArgument(args);
        if (callback == null || !gatewayId.matches("[A-Za-z0-9_-]{1,120}") || !gatewayConfigured()) {
            return mediaFailure(CAPABILITIES.get("media.bookmark"), gatewayId,
                    "The synced spot could not be loaded for deletion approval.");
        }
        new Thread(() -> {
            try {
                MoaMediaSpotStore.Spot spot = syncedSpot(
                        gatewayClientForBookmarks().mediaBookmark(gatewayId).optJSONObject("bookmark"));
                if (spot == null || !gatewayId.equals(spot.gatewayBookmarkId)) {
                    throw new IllegalStateException("bookmark unavailable");
                }
                materializeRemoteDeleteTarget(args, spot);
                callback.onResult(bindBookmarkApproval(requestId, operation, args));
            } catch (Exception unavailable) {
                callback.onResult(mediaFailure(CAPABILITIES.get("media.bookmark"), gatewayId,
                        "The synced spot could not be loaded for deletion approval."));
            }
        }, "moa-media-bookmark-delete-prepare").start();
        return ToolExecutionResult.pending("Loading the synced spot for deletion approval.");
    }

    static void materializeRemoteDeleteTarget(JSONObject args, MoaMediaSpotStore.Spot spot) {
        try {
            args.put("_remote_gateway_id", spot.gatewayBookmarkId);
            args.put("_remote_label", spot.label);
            args.put("_remote_video_id", spot.mediaId);
            args.put("_remote_position_ms", spot.positionMs);
        } catch (JSONException ignored) {
        }
    }

    static MoaMediaSpotStore.Spot boundRemoteDeleteTarget(JSONObject args) {
        String id = safe(args == null ? "" : args.optString("_remote_gateway_id", ""));
        String videoId = safe(args == null ? "" : args.optString("_remote_video_id", ""));
        String label = safe(args == null ? "" : args.optString("_remote_label", ""));
        long position = args == null ? -1L : args.optLong("_remote_position_ms", -1L);
        if (!id.matches("[A-Za-z0-9_-]{1,120}")
                || !MoaMediaSpotStore.isValidYouTubeVideoId(videoId)
                || label.isEmpty() || position < 0L) return null;
        long now = System.currentTimeMillis();
        return new MoaMediaSpotStore.Spot("remote_delete_" + id, label, "", label,
                "youtube", "", videoId, MoaMediaSpotStore.canonicalYouTubeWatchUri(videoId),
                position, position, "gateway_synced", now, now, null, id);
    }

    private ToolExecutionResult bindBookmarkApproval(
            String requestId, String operation, JSONObject args) {
        try {
            approvals.bind(requestId, "media.bookmark", args, MEDIA_STORE_AUTHORITY,
                    System.currentTimeMillis(), System.currentTimeMillis() + 120_000L);
        } catch (RuntimeException error) {
            return mediaFailure(CAPABILITIES.get("media.bookmark"), "bookmark",
                    "Bookmark approval could not be bound to this request.");
        }
        return ToolExecutionResult.confirmation(bookmarkDisclosure(operation, args));
    }

    private ToolExecutionResult captureMediaSpotForConfirmation(
            String requestId, JSONObject args, MoaMediaSessionController.Snapshot snapshot,
            ToolResultCallback callback) {
        MoaYoutubeAccessibilityExecutor.Request request = new MoaYoutubeAccessibilityExecutor.Request(
                requestId, MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID,
                snapshot.packageName, MoaAccessibilityService.currentActiveWindowId(),
                snapshot.title, "", "", "",
                System.currentTimeMillis() + MoaYoutubeUiPolicy.MAX_OPERATION_LIFETIME_MS);
        MoaAccessibilityService.YoutubeStartResult started =
                MoaAccessibilityService.executeYoutubeOperation(request, result -> {
                    if (result.outcome != MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE
                            || !MoaMediaSpotStore.isValidYouTubeVideoId(result.videoId)
                            || !rawVideoIdMatchesCapture(args, result.videoId)) {
                        callback.onResult(mediaFailure(CAPABILITIES.get("media.bookmark"),
                                snapshot.packageName, "Video ID capture stopped: " + result.reason + "."));
                        return;
                    }
                    MoaMediaSessionController.Snapshot fresh =
                            mediaSessions.currentSnapshot(snapshot.packageName);
                    if (fresh == null || !snapshot.mediaFingerprint.equals(fresh.mediaFingerprint)) {
                        callback.onResult(mediaFailure(CAPABILITIES.get("media.bookmark"),
                                snapshot.packageName, "The current video changed during ID capture."));
                        return;
                    }
                    materializeBookmarkIdentity(
                            args, result.videoId, fresh.positionMs, "adapter_extracted");
                    callback.onResult(bindBookmarkApproval(requestId, "remember", args));
                });
        if (started != MoaAccessibilityService.YoutubeStartResult.STARTED) {
            return mediaFailure(CAPABILITIES.get("media.bookmark"), snapshot.packageName,
                    started == MoaAccessibilityService.YoutubeStartResult.BUSY
                            ? "Another YouTube operation is already running."
                            : "Screen access is unavailable to capture the current video ID.");
        }
        return ToolExecutionResult.pending("Identifying the exact video before confirmation.");
    }

    static void materializeBookmarkIdentity(
            JSONObject args, String videoId, long positionMs, String provenance) {
        try {
            args.put("video_id", videoId);
            args.put("position_ms", Math.max(0L, positionMs));
            args.put("_media_identity_provenance", safe(provenance));
        } catch (JSONException ignored) {
        }
    }

    static boolean rawVideoIdMatchesCapture(JSONObject args, String capturedVideoId) {
        String requested = MoaYoutubeUiPolicy.extractVideoId(
                args == null ? "" : args.optString("video_id", ""));
        return requested.isEmpty() || requested.equals(capturedVideoId);
    }

    static String canonicalYoutubeVideoId(String candidate) {
        String validated = MoaMediaSessionController.validatedYouTubeHttpsUri(candidate);
        return validated.isEmpty() ? "" : MoaYoutubeUiPolicy.extractVideoId(validated);
    }

    private String bookmarkDisclosure(String operation, JSONObject args) {
        MoaMediaSpotStore.Spot existing = Set.of("delete", "remove").contains(operation)
                ? findMediaSpot(args) : null;
        if (existing == null && Set.of("delete", "remove").contains(operation)) {
            existing = boundRemoteDeleteTarget(args);
        }
        String label = existing == null
                ? safe(args.optString("label", args.optString("name", "unnamed"))) : existing.label;
        String video = existing == null ? firstNonEmpty(
                args.optString("video_id", ""), MoaYoutubeUiPolicy.extractVideoId(
                        args.optString("url", args.optString("canonical_url", ""))))
                : existing.mediaId;
        long position = existing == null
                ? mediaPositionMs(args)
                : existing.positionMs;
        String note = existing == null ? safe(args.optString("note", "")) : existing.note;
        return (Set.of("delete", "remove").contains(operation) ? "Delete" : "Remember")
                + " bookmark. Label: \"" + label + "\". Video: " + video
                + ". Position: " + position + " ms. Note: "
                + (note.isEmpty() ? "none" : "\"" + note + "\"")
                + ". Sync: update your gateway bookmark record.";
    }

    private ToolExecutionResult rememberMediaSpot(
            String requestId, JSONObject args, ToolResultCallback callback) {
        Capability capability = CAPABILITIES.get("media.bookmark");
        String packageName = resolveYoutubePackage(args);
        String requestedId = MoaYoutubeUiPolicy.extractVideoId(args.optString("video_id", ""));
        String provenance = safe(args.optString("_media_identity_provenance", ""));
        if (!MoaMediaSpotStore.isValidYouTubeVideoId(requestedId) || !hasMediaPosition(args)
                || !Set.of("canonical_uri", "session_media_id", "adapter_extracted").contains(provenance)) {
            return mediaFailure(capability, requestedId,
                    "The approved video record is incomplete or no longer provenance-bound.");
        }
        return persistMediaSpot(args, null, packageName, requestedId, provenance);
    }

    private ToolExecutionResult persistMediaSpot(
            JSONObject args, MoaMediaSessionController.Snapshot snapshot,
            String packageName, String videoId, String provenance) {
        Capability capability = CAPABILITIES.get("media.bookmark");
        if (safe(packageName).isEmpty()) {
            return mediaFailure(capability, videoId, "No installed YouTube app is available for this bookmark.");
        }
        String label = safe(args.optString("label", args.optString("name", "")));
        if (label.isEmpty()) {
            return mediaFailure(capability, videoId, "A bookmark label is required.");
        }
        if (!hasMediaPosition(args) && snapshot == null) {
            return mediaFailure(capability, videoId,
                    "A current media session or explicit video position is required to remember a spot.");
        }
        long position = hasMediaPosition(args) ? mediaPositionMs(args) : snapshot.positionMs;
        long duration = snapshot == null ? Math.max(position, 0L) : Math.max(snapshot.durationMs, position);
        String title = safe(args.optString("title", snapshot == null ? label : snapshot.title));
        long now = System.currentTimeMillis();
        String id = "android_" + UUID.randomUUID();
        MoaMediaSpotStore.Spot spot = new MoaMediaSpotStore.Spot(
                id, label, args.optString("note", ""), title.isEmpty() ? label : title,
                packageName, args.optString("instance", ""), videoId,
                MoaMediaSpotStore.canonicalYouTubeWatchUri(videoId), position, duration,
                provenance, now, now, null);
        if (!mediaDeletes.putPendingSync(spot.id)) {
            return mediaFailure(capability, videoId,
                    "The video spot was not stored because sync recovery could not be reserved.");
        }
        if (!mediaSpots.put(spot)) {
            mediaDeletes.removePendingSync(spot.id);
            return mediaFailure(capability, videoId, "The video spot could not be stored locally.");
        }
        syncMediaSpot(spot);
        return mediaSuccess(capability, videoId, "Remembered \"" + label + "\" at " + position + " ms.");
    }

    private ToolExecutionResult listMediaSpots(ToolResultCallback callback) {
        List<MoaMediaSpotStore.Spot> spots = mediaSpots.all();
        if (callback != null && gatewayConfigured()) {
            new Thread(() -> callback.onResult(mergedMediaSpotList(spots)),
                    "moa-media-bookmark-list").start();
            return ToolExecutionResult.pending("Loading synced video spots.");
        }
        return localMediaSpotList(spots, "");
    }

    private ToolExecutionResult localMediaSpotList(
            List<MoaMediaSpotStore.Spot> spots, String suffix) {
        StringBuilder reply = new StringBuilder(spots.isEmpty() ? "No saved video spots." : "Saved video spots: ");
        for (int index = 0; index < Math.min(spots.size(), 40); index++) {
            if (index > 0) reply.append(", ");
            reply.append(spots.get(index).label);
        }
        if (spots.size() > 40) reply.append(" and ").append(spots.size() - 40).append(" more");
        reply.append(suffix);
        return mediaSuccess(bookmarkImplicitCapability(RISK_READ_ONLY), "bookmarks", reply.toString());
    }

    private ToolExecutionResult openMediaSpot(JSONObject args, ToolResultCallback callback) {
        Capability capability = bookmarkImplicitCapability(RISK_NAVIGATION);
        MoaMediaSpotStore.Spot spot = findMediaSpot(args);
        if (spot == null) {
            if (callback != null && gatewayConfigured()) {
                new Thread(() -> callback.onResult(openSyncedMediaSpot(args)),
                        "moa-media-bookmark-open").start();
                return ToolExecutionResult.pending("Resolving the synced video spot.");
            }
            return mediaFailure(capability, "bookmark", "That saved video spot was not found or was ambiguous.");
        }
        String packageName = "gateway_synced".equals(spot.identityStrength)
                ? resolveYoutubePackage(args) : resolveYoutubePackage(args, spot.packageName);
        ToolExecutionResult opened = openYoutubeVideo(
                capability, packageName, spot.mediaId, spot.positionMs);
        if (opened.success) mediaSpots.markOpened(spot.id, System.currentTimeMillis());
        return opened;
    }

    private ToolExecutionResult mergedMediaSpotList(List<MoaMediaSpotStore.Spot> local) {
        try {
            JSONArray remote = gatewayClientForBookmarks().mediaBookmarks().optJSONArray("bookmarks");
            List<MoaMediaSpotStore.Spot> merged = new ArrayList<>(local);
            Set<String> remoteIds = new java.util.HashSet<>();
            for (MoaMediaSpotStore.Spot spot : local) remoteIds.add(spot.gatewayBookmarkId);
            if (remote != null) for (int index = 0; index < remote.length(); index++) {
                MoaMediaSpotStore.Spot spot = syncedSpot(remote.optJSONObject(index));
                if (spot != null && !remoteIds.contains(spot.gatewayBookmarkId)
                        && !mediaDeletes.containsGatewayId(spot.gatewayBookmarkId)
                        && !mediaDeletes.containsVideoId(spot.mediaId)) merged.add(spot);
            }
            return localMediaSpotList(merged, " (local and synced). ");
        } catch (Exception unavailable) {
            return localMediaSpotList(local, " (gateway unavailable). ");
        }
    }

    private ToolExecutionResult openSyncedMediaSpot(JSONObject args) {
        Capability capability = bookmarkImplicitCapability(RISK_NAVIGATION);
        try {
            String id = safe(args.optString("gateway_bookmark_id",
                    args.optString("bookmark_id", args.optString("id", ""))));
            JSONObject payload = id.isEmpty()
                    ? gatewayClientForBookmarks().resolveMediaBookmark(args.optString(
                            "label", args.optString("query", args.optString("name", ""))))
                    : gatewayClientForBookmarks().mediaBookmark(id);
            JSONObject bookmark = payload.optJSONObject("bookmark");
            if (bookmark == null && payload.optJSONObject("resolution") != null) {
                JSONObject resolution = payload.optJSONObject("resolution");
                if ("matched".equals(resolution.optString("status", ""))) {
                    bookmark = resolution.optJSONObject("bookmark");
                }
            }
            MoaMediaSpotStore.Spot spot = syncedSpot(bookmark);
            if (spot == null || mediaDeletes.containsGatewayId(spot.gatewayBookmarkId)
                    || mediaDeletes.containsVideoId(spot.mediaId)) {
                return mediaFailure(capability, "bookmark",
                    "That synced video spot was not found or was ambiguous.");
            }
            mediaSpots.put(spot);
            ToolExecutionResult opened = openYoutubeVideo(capability,
                    resolveYoutubePackage(args), spot.mediaId, spot.positionMs);
            if (opened.success) mediaSpots.markOpened(spot.id, System.currentTimeMillis());
            return opened;
        } catch (Exception unavailable) {
            return mediaFailure(capability, "bookmark", "The synced video spot could not be loaded.");
        }
    }

    static MoaMediaSpotStore.Spot syncedSpot(JSONObject item) {
        if (item == null || !"youtube".equals(item.optString("provider", "youtube"))) return null;
        String gatewayId = safe(item.optString("id", ""));
        String videoId = safe(item.optString("video_id", ""));
        String label = safe(item.optString("label", ""));
        long position = item.optLong("position_ms", -1L);
        if (!gatewayId.matches("[A-Za-z0-9_-]{1,120}")
                || !MoaMediaSpotStore.isValidYouTubeVideoId(videoId)
                || label.isEmpty() || position < 0L) return null;
        long now = System.currentTimeMillis();
        return new MoaMediaSpotStore.Spot(
                "synced_" + gatewayId, label, item.optString("note", ""), label,
                "youtube", "", videoId, MoaMediaSpotStore.canonicalYouTubeWatchUri(videoId),
                position, Math.max(position, 0L), "gateway_synced", now, now, null, gatewayId);
    }

    private boolean gatewayConfigured() {
        return !safe(MoaPrefs.gatewayUrl(context)).isEmpty();
    }

    private MoaGatewayClient gatewayClientForBookmarks() {
        return new MoaGatewayClient(MoaPrefs.gatewayUrl(context), MoaPrefs.gatewayToken(context));
    }

    private static Capability bookmarkImplicitCapability(String risk) {
        return new Capability("media.bookmark", risk, APPROVAL_IMPLICIT);
    }

    private ToolExecutionResult deleteMediaSpot(JSONObject args, ToolResultCallback callback) {
        Capability capability = CAPABILITIES.get("media.bookmark");
        MoaMediaSpotStore.Spot localSpot;
        MoaMediaSpotStore.Spot spot;
        CompletableFuture<String> sync;
        synchronized (mediaSyncs) {
            localSpot = findMediaSpot(args);
            spot = localSpot == null ? boundRemoteDeleteTarget(args) : localSpot;
            sync = localSpot == null ? null : mediaSyncs.get(localSpot.id);
            if (sync == null && localSpot != null
                    && mediaDeletes.pendingSyncIds().contains(localSpot.id)) {
                sync = new CompletableFuture<>();
                sync.completeExceptionally(new IllegalStateException("sync outcome requires reconciliation"));
            }
        }
        if (spot == null) {
            return mediaFailure(capability, "bookmark", "That saved video spot was not found or was ambiguous.");
        }
        if (!safe(spot.gatewayBookmarkId).isEmpty() || sync != null) {
            if (callback == null || !gatewayConfigured()) {
                return mediaFailure(capability, spot.id,
                        "The synced spot was kept because gateway deletion is unavailable. Try again later.");
            }
            MoaMediaSpotStore.Spot expectedLocal = localSpot;
            if (!mediaDeletes.put(expectedLocal == null ? "" : expectedLocal.id,
                    spot.gatewayBookmarkId, spot.mediaId)) {
                return mediaFailure(capability, spot.id,
                        "The delete could not be reserved durably; nothing was changed.");
            }
            CompletableFuture<String> pendingSync = sync;
            new Thread(() -> deleteSyncedMediaSpot(spot, expectedLocal, pendingSync, callback),
                    "moa-media-bookmark-delete").start();
            return ToolExecutionResult.pending("Deleting the synced video spot.");
        }
        if (!mediaSpots.removeIfGenerationMatches(spot)) {
            return mediaFailure(capability, spot.id, "That saved video spot was not found or was ambiguous.");
        }
        return mediaSuccess(capability, spot.id, "Deleted saved spot \"" + spot.label + "\".");
    }

    private void deleteSyncedMediaSpot(
            MoaMediaSpotStore.Spot spot, MoaMediaSpotStore.Spot expectedLocal,
            CompletableFuture<String> sync,
            ToolResultCallback callback) {
        Capability capability = CAPABILITIES.get("media.bookmark");
        try {
            String gatewayId = safe(spot.gatewayBookmarkId);
            if (gatewayId.isEmpty() && sync != null) {
                try {
                    gatewayId = safe(sync.get());
                } catch (Exception createFailed) {
                    JSONObject retried = gatewayClientForBookmarks().createMediaBookmark(
                            mediaSpotSyncPayload(spot));
                    JSONObject bookmark = retried.optJSONObject("bookmark");
                    gatewayId = bookmark == null ? "" : safe(bookmark.optString("id", ""));
                }
            }
            if (!gatewayId.matches("[A-Za-z0-9_-]{1,120}")) {
                throw new IllegalStateException("synced bookmark id unavailable");
            }
            gatewayClientForBookmarks().deleteMediaBookmark(gatewayId);
            boolean removed = expectedLocal == null
                    || mediaSpots.removeIfGenerationMatches(expectedLocal);
            synchronized (mediaSyncs) {
                if (expectedLocal != null) mediaSyncs.remove(expectedLocal.id, sync);
            }
            mediaDeletes.remove(expectedLocal == null ? "" : expectedLocal.id, spot.gatewayBookmarkId);
            if (expectedLocal != null) mediaDeletes.removePendingSync(expectedLocal.id);
            callback.onResult(removed
                    ? mediaSuccess(capability, spot.id, "Deleted saved spot \"" + spot.label + "\".")
                    : mediaFailure(capability, spot.id,
                            "The synced spot was deleted, but its local record had already changed."));
        } catch (Exception unavailable) {
            callback.onResult(mediaFailure(capability, spot.id,
                    "The synced spot was kept because gateway deletion failed. Try again later."));
        }
    }

    private MoaMediaSpotStore.Spot findMediaSpot(JSONObject args) {
        String id = bookmarkIdArgument(args);
        for (MoaMediaSpotStore.Spot spot : mediaSpots.all()) {
            if (!mediaDeletes.containsLocalDelete(spot.id) && mediaSpotMatchesId(spot, id)) return spot;
        }
        if (!id.isEmpty()) return null;
        List<MoaMediaSpotStore.Spot> available = new ArrayList<>();
        for (MoaMediaSpotStore.Spot spot : mediaSpots.all()) {
            if (!mediaDeletes.containsLocalDelete(spot.id)) available.add(spot);
        }
        MoaMediaSpotStore.Resolution resolution = MoaMediaSpotStore.resolve(available,
                args.optString("label", args.optString("query", args.optString("name", ""))));
        return resolution.status == MoaMediaSpotStore.ResolutionStatus.MATCH ? resolution.spot : null;
    }

    static String bookmarkIdArgument(JSONObject args) {
        JSONObject value = args == null ? new JSONObject() : args;
        return safe(value.optString("gateway_bookmark_id",
                value.optString("bookmark_id", value.optString("id", ""))));
    }

    private ToolExecutionResult preparePlaylistTool(String requestId, JSONObject args) {
        Capability capability = CAPABILITIES.get("media.playlist");
        String operation = safe(args.optString("operation", args.optString("action", "")))
                .toLowerCase(Locale.US);
        if (Set.of("get", "inspect", "list", "show").contains(operation)) {
            return mediaFailure(capability, "playlist", "Playlist inspection is not available without the package-bound UI adapter.");
        }
        String packageName = resolveYoutubePackage(args);
        if (safe(requestId).isEmpty() || packageName.isEmpty()
                || playlistKind(args) == null || !approvedYoutubeAutomationPackage(packageName)) {
            return mediaFailure(capability, packageName, "A request id and installed preferred YouTube package are required.");
        }
        if (!materializePlaylistAuthority(args, packageName)) {
            return mediaFailure(capability, packageName,
                    "Fresh package, window, and media evidence were unavailable for approval.");
        }
        try {
            approvals.bind(requestId, "media.playlist", args, packageName,
                    System.currentTimeMillis(), System.currentTimeMillis() + 120_000L);
        } catch (RuntimeException error) {
            return mediaFailure(capability, packageName, "Playlist approval could not be bound to this request.");
        }
        String playlist = safe(args.optString("playlist", args.optString("playlist_name", "")));
        String replacement = safe(args.optString("replacement_name", args.optString("new_name", "")));
        return ToolExecutionResult.confirmation(playlistDisclosure(
                operation, playlist, replacement, packageName));
    }

    static String playlistDisclosure(
            String operation, String playlist, String replacement, String packageName) {
        return "Allow AG to " + safe(operation)
                + (safe(playlist).isEmpty() ? " this playlist" : " playlist \"" + safe(playlist) + "\"")
                + ("rename".equals(safe(operation)) ? " to \"" + safe(replacement) + "\"" : "")
                + " in " + safe(packageName) + "?";
    }

    ToolExecutionResult resolveToolConfirmation(
            String requestId, String tool, JSONObject args, boolean approved,
            ToolResultCallback callback) {
        String toolName = safe(tool).toLowerCase(Locale.US);
        Capability capability = CAPABILITIES.get(toolName);
        if (!Set.of("media.playlist", "media.bookmark").contains(toolName)) {
            return mediaFailure(capability, "approval", "Unsupported confirmation request.");
        }
        if (!approved) {
            MoaActionApprovalController.Decision rejected = approvals.reject(
                    requestId, System.currentTimeMillis());
            if (rejected.outcome == MoaActionApprovalController.Outcome.ALREADY_TERMINAL) {
                return ToolExecutionResult.pending("Approval was already terminal.");
            }
            return mediaFailure(capability, requestId, "Media change cancelled.");
        }
        String currentPackage = "media.bookmark".equals(toolName)
                ? MEDIA_STORE_AUTHORITY : currentPackageName();
        MoaActionApprovalController.Decision decision = approvals.approve(
                requestId, args, currentPackage, System.currentTimeMillis());
        if (decision.outcome == MoaActionApprovalController.Outcome.ALREADY_TERMINAL) {
            return ToolExecutionResult.pending("Approval was already terminal.");
        }
        if (!decision.mayExecute) {
            return mediaFailure(capability, requestId,
                    "The change was not executed because its target or request changed.");
        }
        if ("media.bookmark".equals(toolName)) {
            String operation = safe(args.optString("operation", args.optString("action", "remember")))
                    .toLowerCase(Locale.US);
            return Set.of("delete", "remove").contains(operation)
                    ? deleteMediaSpot(args, callback) : rememberMediaSpot(requestId, args, callback);
        }
        if (youtubePlaylistExecutor == null) {
            return mediaFailure(capability, currentPackage,
                    "Playlist approval was recorded, but the supported YouTube UI adapter is unavailable.");
        }
        return youtubePlaylistExecutor.execute(
                requestId, args, currentPackage, decision.binding, callback);
    }

    private ToolExecutionResult executeYoutubePlaylist(
            String requestId, JSONObject args, String expectedPackage,
            MoaActionApprovalController.Binding binding,
            ToolResultCallback callback) {
        MoaYoutubeAccessibilityExecutor.Kind kind = playlistKind(args);
        if (kind == null || callback == null || binding == null
                || !playlistAuthorityStillMatches(args, expectedPackage)) {
            return mediaFailure(CAPABILITIES.get("media.playlist"), expectedPackage,
                    "Playlist UI automation is not approved for this installed YouTube build.");
        }
        int windowId = args.optInt("_approved_window_id", -1);
        String playlist = args.optString("playlist", args.optString("playlist_name", ""));
        String replacement = args.optString("replacement_name", args.optString("new_name", ""));
        MoaYoutubeAccessibilityExecutor.Request request;
        if (playlistNeedsMediaBinding(kind)) {
            request = new MoaYoutubeAccessibilityExecutor.Request(requestId, kind, expectedPackage,
                    windowId, args.optString("_observed_title", ""), "", playlist, replacement,
                    args.optString("_approved_ui_profile", ""),
                    args.optString("_observed_video_id", ""),
                    args.optString("_observed_title", ""),
                    args.optString("_observed_media_fingerprint", ""), binding.expiresAtMillis);
        } else {
            request = new MoaYoutubeAccessibilityExecutor.Request(requestId, kind, expectedPackage,
                    windowId, "", "", playlist, replacement, binding.expiresAtMillis);
        }
        MoaAccessibilityService.YoutubeStartResult started =
                MoaAccessibilityService.executeYoutubeOperation(request, result -> {
                    boolean success = result.outcome == MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE;
                    String summary = success ? "Playlist operation completed."
                            : "Playlist operation stopped: " + result.reason + ".";
                    Capability capability = CAPABILITIES.get("media.playlist");
                    callback.onResult(success ? mediaSuccess(capability, expectedPackage, summary)
                            : mediaFailure(capability, expectedPackage, summary));
                });
        if (started != MoaAccessibilityService.YoutubeStartResult.STARTED) {
            return mediaFailure(CAPABILITIES.get("media.playlist"), expectedPackage,
                    started == MoaAccessibilityService.YoutubeStartResult.BUSY
                            ? "Another YouTube operation is already running."
                            : "Screen access is unavailable for the playlist operation.");
        }
        return ToolExecutionResult.pending("Playlist operation started.");
    }

    private boolean materializePlaylistAuthority(JSONObject args, String packageName) {
        PackageEvidence evidence = packageEvidence(packageName);
        MoaYoutubeUiPolicy.UiProfile profile = MoaYoutubeUiPolicy.profileForPackage(packageName);
        int windowId = MoaAccessibilityService.currentActiveWindowId();
        if (evidence == null || profile == null || windowId < 0
                || !packageName.equals(currentPackageName())) return false;
        MoaYoutubeAccessibilityExecutor.Kind kind = playlistKind(args);
        try {
            args.put("_approved_package", packageName)
                    .put("_approved_version_code", evidence.versionCode)
                    .put("_approved_signer_sha256", evidence.signerSha256)
                    .put("_approved_ui_profile", profile.version)
                    .put("_approved_window_id", windowId);
            if (playlistNeedsMediaBinding(kind)) {
                MoaMediaSessionController.Snapshot snapshot = mediaSessions.currentSnapshot(packageName);
                String videoId = snapshot == null ? "" : MoaYoutubeUiPolicy.extractVideoId(
                        snapshot.mediaId.isEmpty() ? snapshot.mediaUri : snapshot.mediaId);
                if (snapshot == null || !MoaMediaSpotStore.isValidYouTubeVideoId(videoId)
                        || snapshot.title.isEmpty()) return false;
                args.put("_observed_video_id", videoId)
                        .put("_observed_title", snapshot.title)
                        .put("_observed_media_fingerprint", snapshot.mediaFingerprint);
            }
            return true;
        } catch (JSONException ignored) { return false; }
    }

    private boolean playlistAuthorityStillMatches(JSONObject args, String packageName) {
        PackageEvidence evidence = packageEvidence(packageName);
        MoaYoutubeUiPolicy.UiProfile profile = MoaYoutubeUiPolicy.profileForPackage(packageName);
        if (evidence == null || profile == null || !approvedYoutubeAutomationPackage(packageName)
                || !packageName.equals(args.optString("_approved_package", ""))
                || evidence.versionCode != args.optLong("_approved_version_code", -1L)
                || !evidence.signerSha256.equals(args.optString("_approved_signer_sha256", ""))
                || !profile.version.equals(args.optString("_approved_ui_profile", ""))
                || args.optInt("_approved_window_id", -1) != MoaAccessibilityService.currentActiveWindowId()) {
            return false;
        }
        MoaYoutubeAccessibilityExecutor.Kind kind = playlistKind(args);
        if (!playlistNeedsMediaBinding(kind)) return true;
        MoaMediaSessionController.Snapshot fresh = mediaSessions.currentSnapshot(packageName);
        return fresh != null && fresh.mediaFingerprint.equals(
                args.optString("_observed_media_fingerprint", ""));
    }

    private static boolean playlistNeedsMediaBinding(MoaYoutubeAccessibilityExecutor.Kind kind) {
        return kind == MoaYoutubeAccessibilityExecutor.Kind.ADD_TO_PLAYLIST
                || kind == MoaYoutubeAccessibilityExecutor.Kind.REMOVE_FROM_PLAYLIST
                || kind == MoaYoutubeAccessibilityExecutor.Kind.CREATE_PLAYLIST;
    }

    private static MoaYoutubeAccessibilityExecutor.Kind playlistKind(JSONObject args) {
        String operation = safe(args == null ? "" : args.optString(
                "operation", args.optString("action", ""))).toLowerCase(Locale.US);
        switch (operation) {
            case "add":
            case "add_to_playlist": return MoaYoutubeAccessibilityExecutor.Kind.ADD_TO_PLAYLIST;
            case "remove":
            case "remove_from_playlist": return MoaYoutubeAccessibilityExecutor.Kind.REMOVE_FROM_PLAYLIST;
            case "create": return MoaYoutubeAccessibilityExecutor.Kind.CREATE_PLAYLIST;
            case "rename": return MoaYoutubeAccessibilityExecutor.Kind.RENAME_PLAYLIST;
            case "delete": return MoaYoutubeAccessibilityExecutor.Kind.DELETE_PLAYLIST;
            default: return null;
        }
    }

    private String resolveYoutubePackage(JSONObject args) {
        return resolveYoutubePackage(args, MoaPrefs.preferredYoutubePackage(context));
    }

    private String resolveMediaOpenYoutubePackage(JSONObject args) {
        String appName = safe(args.optString("app_name", args.optString("appName", "")));
        MoaPrefs.YoutubePackageFixture fixture = MoaPrefs.youtubePackageFixture(context);
        String trustedFixture = approvedYoutubePackage(fixture.packageName) ? fixture.packageName : "";
        String fixtureLabel = trustedFixture.isEmpty() ? "" : installedAppLabel(trustedFixture);
        return resolveMediaOpenAppName(appName, MoaPrefs.preferredYoutubePackage(context),
                trustedFixture, fixtureLabel,
                installedYoutubePackages(MoaPrefs.preferredYoutubePackage(context)));
    }

    static String resolveMediaOpenAppName(
            String appName, String savedDefault, String trustedFixturePackage,
            String trustedFixtureLabel, Set<String> installedPackages) {
        String name = normalizeAppLabel(appName);
        Set<String> installed = installedPackages == null ? Collections.emptySet() : installedPackages;
        if (name.isEmpty() || "youtube".equals(name)) {
            return fallbackYoutubePackage(savedDefault, trustedFixturePackage, installed);
        }
        if (Set.of("youtube advanced", "youtube revanced", "advanced", "revanced").contains(name)) {
            return installed.contains(MoaYoutubeUiPolicy.REVANCED_PACKAGE)
                    ? MoaYoutubeUiPolicy.REVANCED_PACKAGE : "";
        }
        if (Set.of("stock", "stock youtube", "official", "official youtube").contains(name)) {
            return installed.contains(MoaYoutubeUiPolicy.OFFICIAL_PACKAGE)
                    ? MoaYoutubeUiPolicy.OFFICIAL_PACKAGE : "";
        }
        if (!safe(trustedFixturePackage).isEmpty()
                && name.equals(normalizeAppLabel(trustedFixtureLabel))
                && installed.contains(trustedFixturePackage)) {
            return trustedFixturePackage;
        }
        return "";
    }

    private String installedAppLabel(String packageName) {
        try {
            PackageManager manager = context.getPackageManager();
            return safe(String.valueOf(manager.getApplicationLabel(
                    manager.getApplicationInfo(packageName, 0))));
        } catch (PackageManager.NameNotFoundException unavailable) {
            return "";
        }
    }

    private String resolveYoutubePackage(JSONObject args, String fallback) {
        String explicit = safe(args.optString("preferred_package", args.optString("preferredPackage", "")));
        String candidate = explicit.isEmpty() ? safe(fallback) : explicit;
        String alias = MoaYoutubeUiPolicy.resolveExpectedPackage(candidate, candidate, installedYoutubePackages(candidate));
        if (!alias.isEmpty()) candidate = alias;
        if (!explicit.isEmpty()) {
            return approvedYoutubePackage(candidate) ? candidate : "";
        }
        MoaPrefs.YoutubePackageFixture fixture = MoaPrefs.youtubePackageFixture(context);
        String approved = approvedYoutubePackage(fixture.packageName) ? fixture.packageName : "";
        return fallbackYoutubePackage(candidate, approved, installedYoutubePackages(candidate));
    }

    static String fallbackYoutubePackage(
            String preferred, String approved, Set<String> installedPackages) {
        Set<String> installed = installedPackages == null ? Collections.emptySet() : installedPackages;
        if (MoaMediaSessionController.isYouTubeLikePackage(preferred) && installed.contains(preferred)) return preferred;
        if (MoaMediaSessionController.isYouTubeLikePackage(approved) && installed.contains(approved)) return approved;
        return installed.contains(MoaYoutubeUiPolicy.OFFICIAL_PACKAGE)
                ? MoaYoutubeUiPolicy.OFFICIAL_PACKAGE : "";
    }

    static boolean hasSuppliedMediaBinding(JSONObject args) {
        return !expectedPackage(args).isEmpty()
                || !safe(args == null ? "" : args.optString(
                        "media_fingerprint", args.optString("fingerprint", ""))).isEmpty();
    }

    static boolean matchesOptionalMediaBinding(
            JSONObject args, MoaMediaSessionController.Snapshot snapshot) {
        if (!hasSuppliedMediaBinding(args)) return true;
        if (snapshot == null) return false;
        String expected = expectedPackage(args);
        String fingerprint = safe(args.optString(
                "media_fingerprint", args.optString("fingerprint", "")));
        return (expected.isEmpty() || MoaMediaSessionController.packageMatches(
                expected, snapshot.packageName))
                && (fingerprint.isEmpty() || fingerprint.equals(snapshot.mediaFingerprint));
    }

    static long relativeMediaPosition(long currentPositionMs, long offsetMs) {
        long boundedCurrent = Math.max(0L, Math.min(
                currentPositionMs, MoaMediaSessionController.MAX_MEDIA_TIME_MS));
        if (offsetMs > 0L && boundedCurrent > MoaMediaSessionController.MAX_MEDIA_TIME_MS - offsetMs) {
            return MoaMediaSessionController.MAX_MEDIA_TIME_MS;
        }
        if (offsetMs < 0L && boundedCurrent < -offsetMs) return 0L;
        return Math.max(0L, Math.min(boundedCurrent + offsetMs,
                MoaMediaSessionController.MAX_MEDIA_TIME_MS));
    }

    static boolean mediaSpotMatchesId(MoaMediaSpotStore.Spot spot, String id) {
        return spot != null && !safe(id).isEmpty()
                && (id.equals(spot.id) || id.equals(spot.gatewayBookmarkId));
    }

    private boolean approvedYoutubeAutomationPackage(String packageName) {
        return MoaYoutubeUiPolicy.profileForPackage(packageName) != null
                && approvedYoutubePackage(packageName);
    }

    private boolean approvedYoutubePackage(String packageName) {
        PackageEvidence evidence = packageEvidence(packageName);
        return evidence != null && MoaPrefs.youtubePackageFixture(context).matches(
                packageName, evidence.versionCode, evidence.signerSha256);
    }

    private PackageEvidence packageEvidence(String packageName) {
        try {
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            PackageInfo info = context.getPackageManager().getPackageInfo(packageName, flags);
            Signature[] signatures = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()
                    : info.signatures;
            if (signatures == null || signatures.length == 0) return null;
            TreeSet<String> digests = new TreeSet<>();
            for (Signature signature : signatures) {
                byte[] bytes = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray());
                StringBuilder hex = new StringBuilder(64);
                for (byte value : bytes) hex.append(String.format(Locale.US, "%02x", value));
                digests.add(hex.toString());
            }
            long version = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode() : info.versionCode;
            return new PackageEvidence(version, String.join(",", digests));
        } catch (Exception unavailable) {
            return null;
        }
    }

    private Set<String> installedYoutubePackages(String candidate) {
        java.util.HashSet<String> installed = new java.util.HashSet<>();
        for (String item : new String[]{candidate, MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                MoaPrefs.youtubePackageFixture(context).packageName}) {
            if (isInstalled(item)) installed.add(item);
        }
        return installed;
    }

    private boolean isInstalled(String packageName) {
        if (safe(packageName).isEmpty()) return false;
        try {
            context.getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
    }

    static long mediaPositionMs(JSONObject args) {
        JSONObject value = args == null ? new JSONObject() : args;
        if (value.has("position_ms")) return boundedMediaPosition(value.optLong("position_ms", 0L));
        if (value.has("start_position_ms")) return boundedMediaPosition(value.optLong("start_position_ms", 0L));
        long seconds = value.optLong("position_seconds", value.optLong("start_seconds", 0L));
        return boundedMediaPosition(seconds > Long.MAX_VALUE / 1000L ? Long.MAX_VALUE : seconds * 1000L);
    }

    static boolean hasMediaPosition(JSONObject args) {
        return args != null && (args.has("position_ms") || args.has("start_position_ms")
                || args.has("position_seconds") || args.has("start_seconds"));
    }

    private static long boundedMediaPosition(long value) {
        return Math.max(0L, Math.min(value, MoaMediaSessionController.MAX_MEDIA_TIME_MS));
    }

    private ToolExecutionResult mediaSuccess(Capability capability, String target, String reply) {
        return ToolExecutionResult.done(true, reply, recordReceipt(capability, target, true, reply));
    }

    private ToolExecutionResult mediaFailure(Capability capability, String target, String reply) {
        return ToolExecutionResult.done(false, reply, recordReceipt(capability, target, false, reply));
    }

    private ToolExecutionResult mediaOutcome(
            Capability capability, String target, boolean success, String reply, String outcome) {
        JSONObject receipt = capability == null ? null : MoaActionReceiptStore.record(
                context, capability.tool, capability.risk, capability.approval,
                target, success, reply, outcome);
        return ToolExecutionResult.done(success, reply, receipt);
    }

    private void syncMediaSpot(MoaMediaSpotStore.Spot spot) {
        String gatewayUrl = MoaPrefs.gatewayUrl(context);
        if (safe(gatewayUrl).isEmpty()) return;
        CompletableFuture<String> sync = new CompletableFuture<>();
        mediaSyncs.put(spot.id, sync);
        new Thread(() -> {
            try {
                JSONObject body = mediaSpotSyncPayload(spot);
                JSONObject response = new MoaGatewayClient(gatewayUrl, MoaPrefs.gatewayToken(context))
                        .createMediaBookmark(body);
                JSONObject bookmark = response.optJSONObject("bookmark");
                String gatewayId = bookmark == null ? "" : safe(bookmark.optString("id", ""));
                if (!gatewayId.matches("[A-Za-z0-9_-]{1,120}")) {
                    throw new IllegalStateException("gateway bookmark id unavailable");
                }
                synchronized (mediaSyncs) {
                    boolean attached = mediaSpots.attachGatewayBookmarkId(spot, gatewayId);
                    sync.complete(gatewayId);
                    mediaSyncs.remove(spot.id, sync);
                    if (!attached) mediaDeletes.put("", gatewayId, spot.mediaId);
                    mediaDeletes.removePendingSync(spot.id);
                }
            } catch (Exception unavailable) {
                sync.completeExceptionally(unavailable);
                // Local durability is authoritative for the just-completed action.
            }
        }, "moa-media-bookmark-sync").start();
    }

    private void retryPendingMediaDeletes() {
        if (!gatewayConfigured() || mediaDeletes.all().isEmpty()) return;
        new Thread(() -> {
            for (MoaMediaDeleteJournal.Entry entry : mediaDeletes.all()) {
                MoaMediaSpotStore.Spot local = localMediaSpot(entry.localId);
                try {
                    String gatewayId = entry.gatewayId;
                    if (gatewayId.isEmpty() && local != null) {
                        JSONObject response = gatewayClientForBookmarks().createMediaBookmark(
                                mediaSpotSyncPayload(local));
                        JSONObject bookmark = response.optJSONObject("bookmark");
                        gatewayId = bookmark == null ? "" : safe(bookmark.optString("id", ""));
                    }
                    if (!gatewayId.matches("[A-Za-z0-9_-]{1,120}")) continue;
                    gatewayClientForBookmarks().deleteMediaBookmark(gatewayId);
                    if (local != null) mediaSpots.removeIfGenerationMatches(local);
                    mediaDeletes.remove(entry.localId, entry.gatewayId);
                } catch (Exception retryLater) {
                    // The durable entry remains for the next process or explicit retry.
                }
            }
        }, "moa-media-delete-retry").start();
    }

    private void retryPendingMediaSyncs() {
        if (!gatewayConfigured()) return;
        for (String localId : mediaDeletes.pendingSyncIds()) {
            MoaMediaSpotStore.Spot spot = localMediaSpot(localId);
            if (spot != null && !mediaDeletes.containsLocalDelete(localId)) syncMediaSpot(spot);
        }
    }

    private MoaMediaSpotStore.Spot localMediaSpot(String id) {
        for (MoaMediaSpotStore.Spot spot : mediaSpots.all()) if (spot.id.equals(id)) return spot;
        return null;
    }

    static JSONObject mediaSpotSyncPayload(MoaMediaSpotStore.Spot spot) throws JSONException {
        return new JSONObject()
                .put("provider", "youtube")
                .put("video_id", spot.mediaId)
                .put("canonical_url", spot.mediaUri)
                .put("position_ms", spot.positionMs)
                .put("label", spot.label)
                .put("note", spot.note)
                .put("aliases", new JSONArray())
                .put("source_surface", "android")
                .put("idempotency_key", spot.id)
                .put("user_approved", true);
    }

    private ToolExecutionResult listLauncherAppsForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("app.list");
        java.util.Iterator<String> keys = args.keys();
        while (keys.hasNext()) if (!"limit".equals(keys.next())) {
            return ToolExecutionResult.done(false, "app.list accepts only a bounded limit.",
                    recordReceipt(capability, "launcher_apps", false, "Rejected unapproved app.list input."));
        }
        MoaAppLaunchPolicy.LabelProjection projection = MoaAppLaunchPolicy.projectVisibleLabels(
                MoaAppLaunchPolicy.installedLauncherCandidates(context.getPackageManager()),
                args.optInt("limit", MoaAppLaunchPolicy.DEFAULT_LIST_LIMIT));
        String reply = MoaAppLaunchPolicy.formatListReply(projection.labels, projection.total);
        JSONObject receipt = recordReceipt(capability, "launcher_apps", true,
                "Listed " + projection.labels.size() + " launcher apps.");
        return ToolExecutionResult.done(true, reply, receipt);
    }

    private LocalActionResult openLauncherApp(String target) {
        JSONObject input = new JSONObject();
        try { input.put("app_name", target); } catch (JSONException ignored) {}
        return LocalActionResult.handled(openLauncherAppForTool(input).reply);
    }

    private ToolExecutionResult openLauncherAppForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("app.launch");
        List<MoaAppLaunchPolicy.Candidate> installed =
                MoaAppLaunchPolicy.installedLauncherCandidates(context.getPackageManager());
        MoaAppLaunchPolicy.Resolution resolution = MoaAppLaunchPolicy.resolveToolInput(args, installed);
        String target = safe(args.optString("app_name", args.optString("appName",
                args.optString("name", args.optString("app", "")))));
        if (resolution.status == MoaAppLaunchPolicy.Status.INVALID_LABEL
                || resolution.status == MoaAppLaunchPolicy.Status.RAW_APPLICATION_ID) {
            return ToolExecutionResult.done(false, "Use a visible app name; raw package or intent input is not allowed.",
                    recordReceipt(capability, "launcher_app", false, "Rejected non-label app launch input."));
        }
        String normalizedTarget = normalizeAppLabel(target);
        if (normalizedTarget.equals("youtube") || normalizedTarget.equals("youtube advanced")
                || normalizedTarget.equals("youtube revanced")) {
            JSONObject mediaArgs = new JSONObject();
            try {
                if (!normalizedTarget.equals("youtube")) mediaArgs.put("preferred_package", "advanced");
            } catch (JSONException ignored) {
            }
            String packageName = resolveYoutubePackage(mediaArgs);
            Intent launch = packageName.isEmpty() ? null
                    : context.getPackageManager().getLaunchIntentForPackage(packageName);
            if (launch != null) {
                try {
                    context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    return ToolExecutionResult.done(true, "Opened " + packageName + ".",
                            recordReceipt(capability, packageName, true, "Opened preferred YouTube app."));
                } catch (RuntimeException ignored) {
                }
            }
        }
        if (resolution.status == MoaAppLaunchPolicy.Status.NOT_FOUND) {
            JSONObject receipt = recordReceipt(capability, target, false, "No matching launcher app.");
            return ToolExecutionResult.done(false, "I could not find an installed app matching \"" + target + "\".", receipt);
        }
        if (resolution.status == MoaAppLaunchPolicy.Status.AMBIGUOUS) {
            String names = String.join(", ", resolution.candidateLabels);
            JSONObject receipt = recordReceipt(capability, target, false, "Multiple launcher app matches.");
            return ToolExecutionResult.done(false, "I found multiple apps matching \"" + target + "\": " + names + ". Say the full app name.", receipt);
        }
        MoaAppLaunchPolicy.Candidate app = resolution.candidate;
        Intent launchIntent = MoaAppLaunchPolicy.explicitLauncherIntent(app);
        try {
            context.startActivity(launchIntent);
            JSONObject receipt = recordReceipt(capability, app.label, true, "Opened launcher app.");
            return ToolExecutionResult.done(true, "Opened " + app.label + ".", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, app.label, false, "Launch failed.");
            return ToolExecutionResult.done(false, "I could not open " + app.label + ".", receipt);
        }
    }

    private ToolExecutionResult composeEmailDraft(JSONObject args) {
        Capability capability = CAPABILITIES.get("email.compose");
        String recipient = emailDraftRecipient(args);
        String subject = emailDraftSubject(args);
        String body = emailDraftBody(args);
        if (recipient.isEmpty() && subject.isEmpty() && body.isEmpty()) {
            JSONObject receipt = recordReceipt(capability, "email_draft", false, "Email recipient, subject, or body is required.");
            return ToolExecutionResult.done(false, "Email recipient, subject, or body is required.", receipt);
        }

        Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"));
        if (!recipient.isEmpty()) {
            intent.putExtra(Intent.EXTRA_EMAIL, splitAddressList(recipient));
        }
        if (!subject.isEmpty()) {
            intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        }
        if (!body.isEmpty()) {
            intent.putExtra(Intent.EXTRA_TEXT, body);
        }
        return openDraftIntent(
                capability,
                recipient.isEmpty() ? "email_draft" : "email:" + recipient,
                intent,
                "Opened an email draft. Review and send it in your email app.",
                "I could not open an email draft app."
        );
    }

    private ToolExecutionResult composeSmsDraft(JSONObject args) {
        Capability capability = CAPABILITIES.get("sms.compose");
        String recipient = smsDraftRecipient(args);
        String body = smsDraftBody(args);
        if (recipient.isEmpty() && body.isEmpty()) {
            JSONObject receipt = recordReceipt(capability, "sms_draft", false, "SMS recipient or message is required.");
            return ToolExecutionResult.done(false, "SMS recipient or message is required.", receipt);
        }

        Intent intent = new Intent(Intent.ACTION_SENDTO, smstoUri(recipient));
        if (!body.isEmpty()) {
            intent.putExtra("sms_body", body);
        }
        return openDraftIntent(
                capability,
                recipient.isEmpty() ? "sms_draft" : "sms:" + recipient,
                intent,
                "Opened an SMS draft. Review and send it in your messages app.",
                "I could not open an SMS draft app."
        );
    }

    private ToolExecutionResult openDraftIntent(Capability capability, String target, Intent intent, String successReply, String failureReply) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, target, true, "Opened draft compose intent.");
            return ToolExecutionResult.done(true, successReply, receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, target, false, "No draft compose handler.");
            return ToolExecutionResult.done(false, failureReply, receipt);
        }
    }

    private ToolExecutionResult openUrlForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("url.open");
        String rawUrl = openUrlTarget(args);
        String url = sanitizeOpenUrl(rawUrl);
        if (url.isEmpty()) {
            String reason = rawUrl.isEmpty() ? "A web URL is required." : "Only http and https links can be opened.";
            JSONObject receipt = recordReceipt(capability, rawUrl, false, reason);
            return ToolExecutionResult.done(false, reason, receipt);
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, url, true, "Opened URL.");
            return ToolExecutionResult.done(true, "Opened " + url + ".", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, url, false, "No handler for URL.");
            return ToolExecutionResult.done(false, "I could not open that link.", receipt);
        }
    }

    private ToolExecutionResult dialNumberForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("phone.dial");
        String rawNumber = dialNumberTarget(args);
        String number = normalizeDialNumber(rawNumber);
        if (number.isEmpty()) {
            String reason = rawNumber.isEmpty() ? "A phone number is required." : "That does not look like a phone number.";
            JSONObject receipt = recordReceipt(capability, rawNumber, false, reason);
            return ToolExecutionResult.done(false, reason, receipt);
        }
        // ACTION_DIAL only pre-fills the dialer; the user still presses call. No
        // CALL_PHONE permission, no auto-call. Do not change this to ACTION_CALL.
        Intent intent = new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, number, true, "Opened dialer pre-filled with the number.");
            return ToolExecutionResult.done(true, "Opened the dialer with " + number + ". Press call to dial.", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, number, false, "No dialer available.");
            return ToolExecutionResult.done(false, "I could not open the dialer.", receipt);
        }
    }

    private ToolExecutionResult openContactForTool(JSONObject args) {
        Capability capability = CAPABILITIES.get("contact.open");
        String name = contactOpenName(args);
        if (name.isEmpty()) {
            JSONObject receipt = recordReceipt(capability, "", false, "Contact name is required.");
            return ToolExecutionResult.done(false, "Tell me the contact name to open.", receipt);
        }
        if (!hasContactsPermission()) {
            JSONObject receipt = recordReceipt(capability, name, false, "Contacts permission not granted.");
            return ToolExecutionResult.done(false, CONTACTS_PERMISSION_MISSING, receipt);
        }
        Uri lookupUri = findContactLookupUri(name);
        if (lookupUri == null) {
            JSONObject receipt = recordReceipt(capability, name, false, "No matching contact.");
            return ToolExecutionResult.done(false, contactNotFoundReply(name), receipt);
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, lookupUri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            JSONObject receipt = recordReceipt(capability, name, true, "Opened contact card.");
            return ToolExecutionResult.done(true, "Opened the contact card for " + name + ".", receipt);
        } catch (RuntimeException error) {
            JSONObject receipt = recordReceipt(capability, name, false, "No contacts app available.");
            return ToolExecutionResult.done(false, "I could not open the contact card.", receipt);
        }
    }

    private boolean hasContactsPermission() {
        return context.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
    }

    private Uri findContactLookupUri(String name) {
        Uri filterUri = Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_FILTER_URI, Uri.encode(name));
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                    filterUri,
                    new String[]{ContactsContract.Contacts._ID, ContactsContract.Contacts.LOOKUP_KEY},
                    null,
                    null,
                    null
            );
            if (cursor != null && cursor.moveToFirst()) {
                long id = cursor.getLong(0);
                String lookupKey = cursor.getString(1);
                return ContactsContract.Contacts.getLookupUri(id, lookupKey);
            }
        } catch (RuntimeException error) {
            return null;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return null;
    }

    static String openAppTarget(String text) {
        String trimmed = safe(text);
        String lower = trimmed.toLowerCase(Locale.US);
        String[] prefixes = {
                "/open app ",
                "/launch app ",
                "open app ",
                "launch app ",
                "start app "
        };
        for (String prefix : prefixes) {
            if (lower.startsWith(prefix)) {
                return trimmed.substring(prefix.length()).trim();
            }
        }
        return "";
    }

    static boolean isAppListCommand(String text) {
        String lower = safe(text).toLowerCase(Locale.US);
        return "/apps".equals(lower) || "/list apps".equals(lower);
    }

    static String normalizeAppLabel(String value) {
        return safe(value)
                .toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9]+", " ")
                .trim();
    }

    static String emailDraftRecipient(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("to", args.optString("recipient", args.optString("email", ""))));
    }

    static String emailDraftSubject(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("subject", args.optString("title", "")));
    }

    static String emailDraftBody(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("body", args.optString("message", args.optString("text", ""))));
    }

    static String smsDraftRecipient(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("to", args.optString("recipient", args.optString("phone", args.optString("number", "")))));
    }

    static String smsDraftBody(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("body", args.optString("message", args.optString("text", ""))));
    }

    static final String CONTACTS_PERMISSION_MISSING =
            "Contacts permission not granted. Open the AG app to grant it.";

    static String openUrlTarget(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("url", args.optString("link", args.optString("href", ""))));
    }

    // http/https only. Returns the trimmed URL when the scheme is allowed,
    // otherwise "" so the caller rejects javascript:, file:, content:, intent:
    // and every other non-web scheme before ACTION_VIEW.
    static String sanitizeOpenUrl(String value) {
        String trimmed = safe(value);
        if (trimmed.isEmpty()) {
            return "";
        }
        int schemeEnd = trimmed.indexOf("://");
        if (schemeEnd <= 0) {
            return "";
        }
        String scheme = trimmed.substring(0, schemeEnd).toLowerCase(Locale.US);
        if (scheme.equals("http") || scheme.equals("https")) {
            return trimmed;
        }
        return "";
    }

    static String dialNumberTarget(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("number", args.optString("phone", args.optString("tel", args.optString("to", "")))));
    }

    // Strip spaces, dashes, parens, and dots; keep a single leading +; digits
    // only otherwise. Returns "" for empty input or garbage (letters, stray
    // symbols, a lone +) so the dialer never opens on nonsense.
    static String normalizeDialNumber(String value) {
        String trimmed = safe(value);
        if (trimmed.isEmpty()) {
            return "";
        }
        boolean leadingPlus = trimmed.charAt(0) == '+';
        String body = leadingPlus ? trimmed.substring(1) : trimmed;
        StringBuilder digits = new StringBuilder();
        for (int i = 0; i < body.length(); i += 1) {
            char c = body.charAt(i);
            if (c >= '0' && c <= '9') {
                digits.append(c);
            } else if (c == ' ' || c == '-' || c == '(' || c == ')' || c == '.' || c == '\t') {
                // allowed formatting, drop it
            } else {
                // letters, a second +, or any other symbol -> reject as garbage
                return "";
            }
        }
        if (digits.length() == 0) {
            return "";
        }
        return (leadingPlus ? "+" : "") + digits;
    }

    static String contactOpenName(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("name", args.optString("contact", args.optString("person", args.optString("query", "")))));
    }

    static String contactNotFoundReply(String name) {
        return "No contact found matching \"" + safe(name) + "\".";
    }

    static boolean isKnownTool(String tool) {
        return CAPABILITIES.containsKey(safe(tool).toLowerCase(Locale.US));
    }

    static String capabilityRisk(String tool) {
        Capability capability = CAPABILITIES.get(safe(tool).toLowerCase(Locale.US));
        return capability == null ? "" : capability.risk;
    }

    static String capabilityApproval(String tool) {
        Capability capability = CAPABILITIES.get(safe(tool).toLowerCase(Locale.US));
        return capability == null ? "" : capability.approval;
    }

    private static String[] splitAddressList(String recipients) {
        String[] raw = safe(recipients).split("[,;]");
        List<String> addresses = new ArrayList<>();
        for (String item : raw) {
            String address = safe(item);
            if (!address.isEmpty()) {
                addresses.add(address);
            }
        }
        return addresses.toArray(new String[0]);
    }

    private static Uri smstoUri(String recipient) {
        String target = safe(recipient);
        return target.isEmpty() ? Uri.parse("smsto:") : Uri.parse("smsto:" + Uri.encode(target));
    }

    // Keep this list in sync with OverlayService.androidLocalToolManifest(),
    // which advertises the same tools to the gateway cross-device hub.
    private static Map<String, Capability> createCapabilityManifest() {
        Map<String, Capability> capabilities = new HashMap<>();
        capabilities.put("screen.summary", new Capability("screen.summary", RISK_READ_ONLY, "none"));
        capabilities.put("screen.tap_text", new Capability("screen.tap_text", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.back", new Capability("system.back", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.home", new Capability("system.home", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("app.launch", new Capability("app.launch", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("app.list", new Capability("app.list", RISK_READ_ONLY, "none"));
        capabilities.put("ui.control_center", new Capability("ui.control_center", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("email.compose", new Capability("email.compose", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_TARGET_APP_CONFIRMATION));
        capabilities.put("sms.compose", new Capability("sms.compose", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_TARGET_APP_CONFIRMATION));
        capabilities.put("url.open", new Capability("url.open", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("phone.dial", new Capability("phone.dial", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_TARGET_APP_CONFIRMATION));
        capabilities.put("contact.open", new Capability("contact.open", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("media.open", new Capability("media.open", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("media.control", new Capability("media.control", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("media.bookmark", new Capability("media.bookmark", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_LOCAL_CONFIRMATION));
        capabilities.put("media.playlist", new Capability("media.playlist", RISK_EXTERNAL_SIDE_EFFECT, APPROVAL_LOCAL_CONFIRMATION));
        capabilities.put("external.side_effect", new Capability("external.side_effect", RISK_EXTERNAL_SIDE_EFFECT, "confirm"));
        capabilities.put("sensitive.side_effect", new Capability("sensitive.side_effect", "sensitive_side_effect", "blocked"));
        return Collections.unmodifiableMap(capabilities);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) if (!safe(value).isEmpty()) return safe(value);
        return "";
    }

    static final class LocalActionResult {
        final boolean handled;
        final String reply;

        private LocalActionResult(boolean handled, String reply) {
            this.handled = handled;
            this.reply = reply;
        }

        static LocalActionResult handled(String reply) {
            return new LocalActionResult(true, reply == null ? "" : reply);
        }

        static LocalActionResult notHandled() {
            return new LocalActionResult(false, "");
        }
    }

    static final class ToolExecutionResult {
        final boolean success;
        final String reply;
        final JSONObject receipt;
        final boolean requiresConfirmation;
        final boolean pending;

        private ToolExecutionResult(
                boolean success, String reply, JSONObject receipt,
                boolean requiresConfirmation, boolean pending) {
            this.success = success;
            this.reply = reply == null ? "" : reply;
            this.receipt = receipt;
            this.requiresConfirmation = requiresConfirmation;
            this.pending = pending;
        }

        static ToolExecutionResult done(boolean success, String reply, JSONObject receipt) {
            return new ToolExecutionResult(success, reply, receipt, false, false);
        }

        static ToolExecutionResult confirmation(String reply) {
            return new ToolExecutionResult(false, reply, null, true, false);
        }

        static ToolExecutionResult pending(String reply) {
            return new ToolExecutionResult(false, reply, null, false, true);
        }
    }

    interface YoutubePlaylistExecutor {
        ToolExecutionResult execute(
                String requestId, JSONObject args, String expectedPackage,
                MoaActionApprovalController.Binding binding,
                ToolResultCallback callback);
    }

    interface ToolResultCallback {
        void onResult(ToolExecutionResult result);
    }

    private static final class Capability {
        final String tool;
        final String risk;
        final String approval;

        Capability(String tool, String risk, String approval) {
            this.tool = tool;
            this.risk = risk;
            this.approval = approval;
        }
    }

    private static final class PackageEvidence {
        final long versionCode;
        final String signerSha256;

        PackageEvidence(long versionCode, String signerSha256) {
            this.versionCode = versionCode;
            this.signerSha256 = signerSha256;
        }
    }

}

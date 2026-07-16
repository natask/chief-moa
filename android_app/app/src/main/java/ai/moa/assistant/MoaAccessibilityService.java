package ai.moa.assistant;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.text.TextUtils;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.Locale;
import java.util.Set;

public final class MoaAccessibilityService extends AccessibilityService {
    private static final int MAX_SUMMARY_CHARS = 1800;
    private static final int MAX_NODE_TEXTS = 44;
    private static volatile MoaAccessibilityService activeService;
    private static volatile String latestSummary = "";
    private static volatile String latestPackage = "";
    private static volatile String latestClass = "";
    private static volatile long latestUpdatedAtMs = 0L;
    private static final AtomicLong SERVICE_GENERATION = new AtomicLong(0L);
    private static final AtomicLong WINDOW_GENERATION = new AtomicLong(0L);
    private static volatile ProgramObservation latestProgramObservation;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        activeService = this;
        SERVICE_GENERATION.incrementAndGet();
        WINDOW_GENERATION.incrementAndGet();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        activeService = this;
        WINDOW_GENERATION.incrementAndGet();
        latestProgramObservation = null;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) {
            return;
        }

        StringBuilder builder = new StringBuilder();
        if (event != null && event.getPackageName() != null) {
            latestPackage = event.getPackageName().toString();
            builder.append("Package: ").append(latestPackage).append('\n');
        }
        if (event != null && event.getClassName() != null) {
            latestClass = event.getClassName().toString();
            builder.append("Class: ").append(latestClass).append('\n');
        }
        builder.append("Visible text: ");

        collectNodeText(root, builder, new HashSet<>(), new int[]{0});
        String summary = builder.toString().trim();
        if (summary.length() > MAX_SUMMARY_CHARS) {
            summary = summary.substring(0, MAX_SUMMARY_CHARS).trim();
        }
        latestSummary = summary;
        latestUpdatedAtMs = System.currentTimeMillis();
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (activeService == this) {
            activeService = null;
        }
        SERVICE_GENERATION.incrementAndGet();
        latestProgramObservation = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        if (activeService == this) {
            activeService = null;
        }
        SERVICE_GENERATION.incrementAndGet();
        latestProgramObservation = null;
        super.onDestroy();
    }

    static boolean isRunning() {
        return activeService != null;
    }

    static String currentScreenSummary() {
        return latestScreenSummary();
    }

    static JSONObject currentScreenSnapshot() {
        if (!isRunning()) {
            return null;
        }

        JSONObject snapshot = new JSONObject();
        try {
            snapshot.put("running", true);
            snapshot.put("available", true);
            snapshot.put("package", latestPackage);
            snapshot.put("class", latestClass);
            snapshot.put("updated_at_ms", latestUpdatedAtMs);
            snapshot.put("summary", latestScreenSummary());
            snapshot.put("active_app", currentActiveAppDescriptor());
        } catch (JSONException ignored) {
        }
        return snapshot;
    }

    static JSONObject currentActiveAppDescriptor() {
        return MoaActiveAppDescriptor.create(
                isRunning(),
                latestPackage,
                latestClass,
                latestUpdatedAtMs,
                System.currentTimeMillis()
        );
    }

    static JSONArray currentExecutionAdapters() {
        return MoaActiveAppDescriptor.executionAdapters(
                isRunning(),
                latestPackage,
                latestClass,
                latestUpdatedAtMs,
                System.currentTimeMillis()
        );
    }

    static TapResult clickByText(String label, String expectedPackage) {
        MoaAccessibilityService service = activeService;
        String target = normalize(label);
        if (service == null || target.isEmpty() || expectedPackage == null || expectedPackage.trim().isEmpty()) {
            return TapResult.UNAVAILABLE;
        }

        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) {
            return TapResult.UNAVAILABLE;
        }
        String actualPackage = root.getPackageName() == null ? "" : root.getPackageName().toString();
        if (!MoaActiveAppDescriptor.packageMatches(expectedPackage, actualPackage)) {
            return TapResult.STALE_TARGET;
        }

        AccessibilityNodeInfo match = findMatchingNode(root, target);
        AccessibilityNodeInfo clickable = firstClickable(match);
        if (clickable == null) {
            return TapResult.NOT_FOUND;
        }
        return clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                ? TapResult.CLICKED
                : TapResult.NOT_FOUND;
    }

    enum TapResult {
        CLICKED,
        STALE_TARGET,
        NOT_FOUND,
        UNAVAILABLE
    }

    static boolean performBack() {
        MoaAccessibilityService service = activeService;
        return service != null && service.performGlobalAction(GLOBAL_ACTION_BACK);
    }

    static boolean performHome() {
        MoaAccessibilityService service = activeService;
        return service != null && service.performGlobalAction(GLOBAL_ACTION_HOME);
    }

    /** Builds a fresh, bounded and redacted Accessibility observation for local programs. */
    static JSONObject currentProgramObservation() {
        MoaAccessibilityService service = activeService;
        if (service == null) return null;
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null || root.getPackageName() == null) return null;
        long now = System.currentTimeMillis();
        long serviceGeneration = SERVICE_GENERATION.get();
        long windowGeneration = WINDOW_GENERATION.get();
        String packageName = root.getPackageName().toString();
        String windowId = String.valueOf(root.getWindowId());
        String observationId = "android_obs_" + UUID.randomUUID();
        JSONArray nodes = new JSONArray();
        List<ProgramNode> records = new ArrayList<>();
        try {
        collectProgramNodes(root, new ArrayList<>(), nodes, records, 0);
        JSONObject body = new JSONObject()
                .put("version", 1)
                .put("observation_id", observationId)
                .put("expected_package", packageName)
                .put("window_id", windowId)
                .put("window_generation", windowGeneration)
                .put("accessibility_service_generation", serviceGeneration)
                .put("observed_at_ms", now)
                .put("expires_at_ms", now + 15_000L)
                .put("nodes", nodes);
        String digest = MoaProgramJson.sha256(MoaProgramJson.canonical(body));
        body.put("observation_digest", digest);
        latestProgramObservation = new ProgramObservation(body, records, now + 15_000L);
        return MoaProgramJson.copy(body);
        } catch (JSONException error) { return null; }
    }

    static JSONObject currentProgramBinding() {
        ProgramObservation cached = latestProgramObservation;
        JSONObject observation = cached != null && System.currentTimeMillis() < cached.expiresAtMs
                ? MoaProgramJson.copy(cached.body) : currentProgramObservation();
        if (observation == null) return null;
        try { return new JSONObject()
                .put("kind", "android_accessibility")
                .put("package_name", observation.getString("expected_package"))
                .put("window_id", observation.getString("window_id"))
                .put("observation_id", observation.getString("observation_id"))
                .put("observation_generation", observation.getLong("window_generation"))
                .put("state_sha256", observation.getString("observation_digest")); }
        catch (JSONException error) { return null; }
    }

    static ProgramActionResult executeProgramAction(MoaSurfaceProgramContract.Proposal proposal, String capabilityId, JSONObject input) {
        MoaAccessibilityService service = activeService;
        if (service == null) return ProgramActionResult.rejected("accessibility_unavailable", "Accessibility service is not running.");
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null || root.getPackageName() == null) return ProgramActionResult.rejected("accessibility_unavailable", "No active Accessibility window.");
        String packageName = root.getPackageName().toString();
        if (!proposal.expectedPackage.equals(packageName)
                || !proposal.windowId.equals(String.valueOf(root.getWindowId()))
                || latestProgramObservation == null
                || latestProgramObservation.body.optLong("window_generation") != WINDOW_GENERATION.get()
                || latestProgramObservation.body.optLong("accessibility_service_generation") != SERVICE_GENERATION.get()) {
            return ProgramActionResult.stale("The bound Android window changed.");
        }
        if (MoaScriptExecutionCatalog.BACK.equals(capabilityId)) {
            return service.performGlobalAction(GLOBAL_ACTION_BACK) ? ProgramActionResult.success("Pressed Back.", null) : ProgramActionResult.failed("Back failed.");
        }
        if (MoaScriptExecutionCatalog.HOME.equals(capabilityId)) {
            return service.performGlobalAction(GLOBAL_ACTION_HOME) ? ProgramActionResult.success("Pressed Home.", null) : ProgramActionResult.failed("Home failed.");
        }
        ProgramObservation observation = latestProgramObservation;
        String observationId = input.optString("observation_id", "");
        String observationDigest = input.optString("observation_digest", "");
        if (observation == null || System.currentTimeMillis() >= observation.expiresAtMs
                || !observation.body.optString("observation_id").equals(observationId)
                || !observation.body.optString("observation_digest").equals(observationDigest)) {
            return ProgramActionResult.stale("The Accessibility observation is stale.");
        }
        String handle = input.optString("node_id", input.optString("handle", ""));
        ProgramNode record = observation.find(handle);
        if (record == null) return ProgramActionResult.stale("The Accessibility node handle is stale.");
        AccessibilityNodeInfo node = followPath(root, record.path);
        if (node == null || !record.fingerprint.equals(nodeFingerprint(node))) return ProgramActionResult.stale("The Accessibility node changed.");
        boolean success;
        if (MoaScriptExecutionCatalog.CLICK.equals(capabilityId)) {
            success = node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        } else if (MoaScriptExecutionCatalog.SET_TEXT.equals(capabilityId)) {
            String value = input.optString("text", null);
            if (value == null || value.length() > 4_096 || node.isPassword() || !node.isEditable()) return ProgramActionResult.rejected("invalid_text_target", "Editable non-password node and bounded text are required.");
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
            success = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        } else if (MoaScriptExecutionCatalog.SCROLL.equals(capabilityId)) {
            String direction = input.optString("direction", "forward");
            int action = "backward".equals(direction) ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
            success = node.performAction(action);
        } else {
            return ProgramActionResult.rejected("unsupported_capability", "Unsupported Accessibility capability.");
        }
        latestProgramObservation = null;
        WINDOW_GENERATION.incrementAndGet();
        return success ? ProgramActionResult.success("Accessibility action completed.", null) : ProgramActionResult.failed("Accessibility action failed.");
    }

    static JSONObject findProgramNodes(JSONObject input) {
        ProgramObservation observation = latestProgramObservation;
        if (observation == null || System.currentTimeMillis() >= observation.expiresAtMs
                || !observation.body.optString("observation_id").equals(input.optString("observation_id", ""))
                || !observation.body.optString("observation_digest").equals(input.optString("observation_digest", ""))) return null;
        String query = normalize(input.optString("query", input.optString("label", "")));
        try {
        JSONArray matches = new JSONArray();
        JSONArray nodes = observation.body.getJSONArray("nodes");
        for (int i = 0; i < nodes.length() && matches.length() < 24; i++) {
            JSONObject node = nodes.getJSONObject(i);
            if (query.isEmpty() || normalize(node.optString("label", "")).contains(query)) matches.put(MoaProgramJson.copy(node));
        }
        return new JSONObject().put("observation_id", observation.body.getString("observation_id"))
                .put("observation_digest", observation.body.getString("observation_digest")).put("nodes", matches);
        } catch (JSONException error) { return null; }
    }

    static boolean programBindingMatches(MoaSurfaceProgramContract.Proposal proposal) {
        ProgramObservation observation = latestProgramObservation;
        if (observation == null || System.currentTimeMillis() >= observation.expiresAtMs) return false;
        return proposal.expectedPackage.equals(observation.body.optString("expected_package"))
                && proposal.windowId.equals(observation.body.optString("window_id"))
                && proposal.observationId.equals(observation.body.optString("observation_id"))
                && proposal.observationGeneration == observation.body.optLong("window_generation")
                && proposal.observationDigest.equals(observation.body.optString("observation_digest"))
                && observation.body.optLong("window_generation") == WINDOW_GENERATION.get()
                && observation.body.optLong("accessibility_service_generation") == SERVICE_GENERATION.get();
    }

    static boolean programTargetMatches(MoaSurfaceProgramContract.Proposal proposal) {
        MoaAccessibilityService service = activeService;
        if (service == null) return false;
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        return root != null && root.getPackageName() != null
                && proposal.expectedPackage.equals(root.getPackageName().toString())
                && proposal.windowId.equals(String.valueOf(root.getWindowId()));
    }

    private static void collectProgramNodes(AccessibilityNodeInfo node, List<Integer> path, JSONArray output, List<ProgramNode> records, int depth) throws JSONException {
        if (node == null || depth > 8 || records.size() >= 128) return;
        String handle = "ax_" + records.size() + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String label = node.isPassword() ? "[redacted]" : boundedLabel(node.getContentDescription(), node.isEditable() ? null : node.getText());
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        JSONArray actions = new JSONArray();
        if (node.isClickable()) actions.put("click");
        if (node.isEditable() && !node.isPassword()) actions.put("set_text");
        if (node.isScrollable()) { actions.put("scroll_forward"); actions.put("scroll_backward"); }
        JSONObject item = new JSONObject().put("node_id", handle)
                .put("role", bounded(node.getClassName(), 120)).put("label", label)
                .put("bounds", new JSONObject().put("left", bounds.left).put("top", bounds.top).put("right", bounds.right).put("bottom", bounds.bottom))
                .put("enabled", node.isEnabled()).put("focused", node.isFocused()).put("actions", actions);
        output.put(item);
        records.add(new ProgramNode(handle, new ArrayList<>(path), nodeFingerprint(node)));
        if (node.isPassword()) return;
        for (int index = 0; index < node.getChildCount() && records.size() < 128; index++) {
            path.add(index); collectProgramNodes(node.getChild(index), path, output, records, depth + 1); path.remove(path.size() - 1);
        }
    }

    private static AccessibilityNodeInfo followPath(AccessibilityNodeInfo root, List<Integer> path) {
        AccessibilityNodeInfo current = root;
        for (Integer index : path) { if (current == null || index < 0 || index >= current.getChildCount()) return null; current = current.getChild(index); }
        return current;
    }

    private static String nodeFingerprint(AccessibilityNodeInfo node) {
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        String source = bounded(node.getClassName(), 120) + "\n" + bounded(node.getViewIdResourceName(), 200) + "\n" + bounds.flattenToString()
                + "\n" + node.isClickable() + "\n" + node.isEditable() + "\n" + node.isScrollable() + "\n" + node.isPassword();
        return MoaProgramJson.sha256(source);
    }

    private static String boundedLabel(CharSequence first, CharSequence second) { String value = bounded(first, 240); return value.isEmpty() ? bounded(second, 240) : value; }
    private static String bounded(CharSequence value, int max) { if (value == null) return ""; String text = value.toString().replaceAll("[\\r\\n\\t]+", " ").replaceAll("\\s+", " ").trim(); return text.length() <= max ? text : text.substring(0, max); }

    private static final class ProgramObservation {
        final JSONObject body; final List<ProgramNode> nodes; final long expiresAtMs;
        ProgramObservation(JSONObject body, List<ProgramNode> nodes, long expiresAtMs) { this.body = body; this.nodes = nodes; this.expiresAtMs = expiresAtMs; }
        ProgramNode find(String handle) { for (ProgramNode node : nodes) if (node.handle.equals(handle)) return node; return null; }
    }
    private static final class ProgramNode {
        final String handle; final List<Integer> path; final String fingerprint;
        ProgramNode(String handle, List<Integer> path, String fingerprint) { this.handle = handle; this.path = path; this.fingerprint = fingerprint; }
    }

    static final class ProgramActionResult {
        final boolean success; final String status, code, summary; final JSONObject data;
        private ProgramActionResult(boolean success, String status, String code, String summary, JSONObject data) { this.success = success; this.status = status; this.code = code; this.summary = summary; this.data = data; }
        static ProgramActionResult success(String summary, JSONObject data) { return new ProgramActionResult(true, "succeeded", "", summary, data); }
        static ProgramActionResult failed(String summary) { return new ProgramActionResult(false, "failed", "action_failed", summary, null); }
        static ProgramActionResult stale(String summary) { return new ProgramActionResult(false, "stale_state", "stale_state", summary, null); }
        static ProgramActionResult rejected(String code, String summary) { return new ProgramActionResult(false, "rejected", code, summary, null); }
    }

    static String latestScreenSummary() {
        return latestSummary == null ? "" : latestSummary.trim();
    }

    static boolean isEnabled(Context context) {
        String enabledServices = Settings.Secure.getString(
                context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (enabledServices == null || enabledServices.trim().isEmpty()) {
            return false;
        }

        String expectedFull = (context.getPackageName() + "/" + MoaAccessibilityService.class.getName()).toLowerCase(Locale.US);
        String expectedShort = (context.getPackageName() + "/.MoaAccessibilityService").toLowerCase(Locale.US);
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabledServices);
        while (splitter.hasNext()) {
            String service = splitter.next().toLowerCase(Locale.US);
            if (service.equals(expectedFull) || service.equals(expectedShort)) {
                return true;
            }
        }
        return false;
    }

    static Intent settingsIntent() {
        return new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
    }

    private static void collectNodeText(AccessibilityNodeInfo node, StringBuilder builder, Set<String> seen, int[] count) {
        if (node == null || count[0] >= MAX_NODE_TEXTS || builder.length() >= MAX_SUMMARY_CHARS) {
            return;
        }

        CharSequence text = node.getText();
        CharSequence description = node.getContentDescription();
        appendText(builder, seen, count, text);
        appendText(builder, seen, count, description);

        for (int i = 0; i < node.getChildCount(); i++) {
            collectNodeText(node.getChild(i), builder, seen, count);
            if (count[0] >= MAX_NODE_TEXTS || builder.length() >= MAX_SUMMARY_CHARS) {
                return;
            }
        }
    }

    private static AccessibilityNodeInfo findMatchingNode(AccessibilityNodeInfo node, String target) {
        if (node == null) {
            return null;
        }

        if (nodeMatches(node, target)) {
            return node;
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findMatchingNode(node.getChild(i), target);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    private static boolean nodeMatches(AccessibilityNodeInfo node, String target) {
        return normalize(node.getText()).contains(target)
                || normalize(node.getContentDescription()).contains(target);
    }

    private static AccessibilityNodeInfo firstClickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        while (current != null) {
            if (current.isClickable() || current.isLongClickable()) {
                return current;
            }
            current = current.getParent();
        }
        return null;
    }

    private static String normalize(CharSequence value) {
        if (value == null) {
            return "";
        }
        return value.toString()
                .toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9 ]", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static void appendText(StringBuilder builder, Set<String> seen, int[] count, CharSequence value) {
        if (value == null || count[0] >= MAX_NODE_TEXTS) {
            return;
        }

        String text = value.toString()
                .replace('\n', ' ')
                .replace('\r', ' ')
                .replaceAll("\\s+", " ")
                .trim();
        if (text.isEmpty() || text.length() < 2 || seen.contains(text)) {
            return;
        }

        if (builder.length() > 0 && builder.charAt(builder.length() - 1) != ' ') {
            builder.append(' ');
        }
        builder.append(text).append(" |");
        seen.add(text);
        count[0]++;
    }
}

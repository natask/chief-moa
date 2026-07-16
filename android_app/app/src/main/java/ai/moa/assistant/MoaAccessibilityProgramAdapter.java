package ai.moa.assistant;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/** Owns the bounded Accessibility observation and action state exposed to local programs. */
final class MoaAccessibilityProgramAdapter {
    private static final long OBSERVATION_TTL_MS = 15_000L;
    private static final AtomicLong SERVICE_GENERATION = new AtomicLong(0L);
    private static final AtomicLong WINDOW_GENERATION = new AtomicLong(0L);
    private static volatile MoaAccessibilityService activeService;
    private static volatile ProgramObservation latestObservation;

    private MoaAccessibilityProgramAdapter() {
    }

    static synchronized void connect(MoaAccessibilityService service) {
        activeService = service;
        SERVICE_GENERATION.incrementAndGet();
        WINDOW_GENERATION.incrementAndGet();
        latestObservation = null;
    }

    static synchronized void onAccessibilityEvent(MoaAccessibilityService service) {
        if (activeService != service) return;
        WINDOW_GENERATION.incrementAndGet();
        latestObservation = null;
    }

    static synchronized void disconnect(MoaAccessibilityService service) {
        if (activeService != service) return;
        activeService = null;
        SERVICE_GENERATION.incrementAndGet();
        latestObservation = null;
    }

    /** Builds a fresh, bounded and redacted Accessibility observation for local programs. */
    static synchronized JSONObject currentObservation() {
        MoaAccessibilityService service = activeService;
        if (service == null) return null;
        AccessibilityNodeInfo root = activeRoot(service);
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
            collectNodes(root, new ArrayList<>(), nodes, records, 0);
            JSONObject body = new JSONObject()
                    .put("version", 1)
                    .put("observation_id", observationId)
                    .put("expected_package", packageName)
                    .put("window_id", windowId)
                    .put("window_generation", windowGeneration)
                    .put("accessibility_service_generation", serviceGeneration)
                    .put("observed_at_ms", now)
                    .put("expires_at_ms", now + OBSERVATION_TTL_MS)
                    .put("nodes", nodes);
            String digest = MoaProgramJson.sha256(MoaProgramJson.canonical(body));
            body.put("observation_digest", digest);
            latestObservation = new ProgramObservation(
                    body,
                    records,
                    structuralFingerprint(records),
                    now + OBSERVATION_TTL_MS
            );
            return MoaProgramJson.copy(body);
        } catch (JSONException error) {
            return null;
        }
    }

    static synchronized JSONObject currentBinding() {
        ProgramObservation cached = latestObservation;
        JSONObject observation = cached != null && System.currentTimeMillis() < cached.expiresAtMs
                ? MoaProgramJson.copy(cached.body) : currentObservation();
        if (observation == null) return null;
        try {
            return new JSONObject()
                    .put("kind", "android_accessibility")
                    .put("package_name", observation.getString("expected_package"))
                    .put("window_id", observation.getString("window_id"))
                    .put("observation_id", observation.getString("observation_id"))
                    .put("observation_generation", observation.getLong("window_generation"))
                    .put("state_sha256", observation.getString("observation_digest"));
        } catch (JSONException error) {
            return null;
        }
    }

    static synchronized JSONObject boundObservation(MoaSurfaceProgramContract.Proposal proposal) {
        ProgramObservation observation = latestObservation;
        return bindingMatches(proposal)
                ? MoaProgramJson.copy(observation.body) : null;
    }

    static synchronized ProgramActionResult execute(
            MoaSurfaceProgramContract.Proposal proposal,
            String capabilityId,
            JSONObject input
    ) {
        if (MoaScriptExecutionCatalog.BACK.equals(capabilityId)) {
            return performGlobalEffect(proposal, AccessibilityService.GLOBAL_ACTION_BACK);
        }
        if (MoaScriptExecutionCatalog.HOME.equals(capabilityId)) {
            return performGlobalEffect(proposal, AccessibilityService.GLOBAL_ACTION_HOME);
        }
        AccessibilityNodeInfo root = validatedRoot(proposal);
        if (root == null) {
            return ProgramActionResult.stale("The bound Android Accessibility state changed.");
        }
        ProgramObservation observation = latestObservation;
        String observationId = input.optString("observation_id", "");
        String observationDigest = input.optString("observation_digest", "");
        if (System.currentTimeMillis() >= observation.expiresAtMs
                || !observation.body.optString("observation_id").equals(observationId)
                || !observation.body.optString("observation_digest").equals(observationDigest)) {
            return ProgramActionResult.stale("The Accessibility observation is stale.");
        }
        String handle = input.optString("node_id", input.optString("handle", ""));
        ProgramNode record = observation.find(handle);
        if (record == null) return ProgramActionResult.stale("The Accessibility node handle is stale.");
        AccessibilityNodeInfo node = followPath(root, record.path);
        if (node == null || !record.fingerprint.equals(nodeFingerprint(node))) {
            return ProgramActionResult.stale("The Accessibility node changed.");
        }
        boolean success;
        if (MoaScriptExecutionCatalog.CLICK.equals(capabilityId)) {
            if (!liveStructureMatches(root, observation)) return staleStructure();
            success = node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        } else if (MoaScriptExecutionCatalog.SET_TEXT.equals(capabilityId)) {
            String value = input.optString("text", null);
            if (value == null || value.length() > 4_096 || node.isPassword() || !node.isEditable()) {
                return ProgramActionResult.rejected(
                        "invalid_text_target",
                        "Editable non-password node and bounded text are required."
                );
            }
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
            if (!liveStructureMatches(root, observation)) return staleStructure();
            success = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        } else if (MoaScriptExecutionCatalog.SCROLL.equals(capabilityId)) {
            String direction = input.optString("direction", "forward");
            int action = "backward".equals(direction)
                    ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                    : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
            if (!liveStructureMatches(root, observation)) return staleStructure();
            success = node.performAction(action);
        } else {
            return ProgramActionResult.rejected("unsupported_capability", "Unsupported Accessibility capability.");
        }
        return actionWithPostState(success);
    }

    static synchronized JSONObject find(JSONObject input) {
        ProgramObservation observation = latestObservation;
        if (observation == null || System.currentTimeMillis() >= observation.expiresAtMs
                || !observation.body.optString("observation_id").equals(input.optString("observation_id", ""))
                || !observation.body.optString("observation_digest").equals(input.optString("observation_digest", ""))) {
            return null;
        }
        String query = normalize(input.optString("query", input.optString("label", "")));
        try {
            JSONArray matches = new JSONArray();
            JSONArray nodes = observation.body.getJSONArray("nodes");
            for (int i = 0; i < nodes.length() && matches.length() < 24; i++) {
                JSONObject node = nodes.getJSONObject(i);
                if (query.isEmpty() || normalize(node.optString("label", "")).contains(query)) {
                    matches.put(MoaProgramJson.copy(node));
                }
            }
            return new JSONObject()
                    .put("observation_id", observation.body.getString("observation_id"))
                    .put("observation_digest", observation.body.getString("observation_digest"))
                    .put("nodes", matches);
        } catch (JSONException error) {
            return null;
        }
    }

    static synchronized boolean bindingMatches(MoaSurfaceProgramContract.Proposal proposal) {
        return validatedRoot(proposal) != null;
    }

    private static AccessibilityNodeInfo validatedRoot(MoaSurfaceProgramContract.Proposal proposal) {
        ProgramObservation observation = latestObservation;
        if (observation == null || System.currentTimeMillis() >= observation.expiresAtMs) return null;
        MoaAccessibilityService service = activeService;
        AccessibilityNodeInfo root = activeRoot(service);
        boolean matches = proposal.expectedPackage.equals(observation.body.optString("expected_package"))
                && proposal.windowId.equals(observation.body.optString("window_id"))
                && proposal.observationId.equals(observation.body.optString("observation_id"))
                && proposal.observationGeneration == observation.body.optLong("window_generation")
                && proposal.observationDigest.equals(observation.body.optString("observation_digest"))
                && observation.body.optLong("window_generation") == WINDOW_GENERATION.get()
                && observation.body.optLong("accessibility_service_generation") == SERVICE_GENERATION.get()
                && root != null && root.getPackageName() != null
                && proposal.expectedPackage.equals(root.getPackageName().toString())
                && proposal.windowId.equals(String.valueOf(root.getWindowId()))
                && liveStructureMatches(root, observation);
        return matches ? root : null;
    }

    static synchronized boolean targetMatches(MoaSurfaceProgramContract.Proposal proposal) {
        MoaAccessibilityService service = activeService;
        if (service == null) return false;
        AccessibilityNodeInfo root = activeRoot(service);
        return root != null && root.getPackageName() != null
                && proposal.expectedPackage.equals(root.getPackageName().toString())
                && proposal.windowId.equals(String.valueOf(root.getWindowId()));
    }

    private static ProgramActionResult actionWithPostState(boolean success) {
        latestObservation = null;
        WINDOW_GENERATION.incrementAndGet();
        if (!success) return ProgramActionResult.failed("Accessibility action failed.");
        // Android only confirms that the action request was accepted. A later Accessibility
        // event is required before a changed UI tree can be treated as post-state evidence.
        return ProgramActionResult.indeterminate();
    }

    private static ProgramActionResult performGlobalEffect(
            MoaSurfaceProgramContract.Proposal proposal,
            int action
    ) {
        // validatedRoot recomputes the complete bounded live structure. Keep the
        // platform effect immediately adjacent so no cached tree authorizes it.
        AccessibilityNodeInfo root = validatedRoot(proposal);
        MoaAccessibilityService service = activeService;
        if (root == null) return staleStructure();
        return actionWithPostState(service.performGlobalAction(action));
    }

    private static ProgramActionResult staleStructure() {
        return ProgramActionResult.stale("The bound Android Accessibility structure changed.");
    }

    private static AccessibilityNodeInfo activeRoot(MoaAccessibilityService service) {
        if (service == null) return null;
        AccessibilityNodeInfo direct = service.getRootInActiveWindow();
        if (direct != null) return direct;
        List<AccessibilityWindowInfo> windows = service.getWindows();
        AccessibilityNodeInfo focused = null;
        for (AccessibilityWindowInfo window : windows) {
            if (window == null) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            if (window.isActive()) return root;
            if (focused == null && window.isFocused()) focused = root;
        }
        return focused;
    }

    private static void collectNodes(
            AccessibilityNodeInfo node,
            List<Integer> path,
            JSONArray output,
            List<ProgramNode> records,
            int depth
    ) throws JSONException {
        if (node == null || depth > 8 || records.size() >= 128) return;
        String handle = "ax_" + records.size() + "_"
                + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String label = node.isPassword()
                ? "[redacted]"
                : boundedLabel(node.isEditable() ? null : node.getContentDescription(),
                        node.isEditable() ? null : node.getText());
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        JSONArray actions = new JSONArray();
        if (node.isClickable()) actions.put("click");
        if (node.isEditable() && !node.isPassword()) actions.put("set_text");
        if (node.isScrollable()) {
            actions.put("scroll_forward");
            actions.put("scroll_backward");
        }
        JSONObject item = new JSONObject()
                .put("node_id", handle)
                .put("role", bounded(node.getClassName(), 120))
                .put("label", label)
                .put("bounds", new JSONObject()
                        .put("left", bounds.left)
                        .put("top", bounds.top)
                        .put("right", bounds.right)
                        .put("bottom", bounds.bottom))
                .put("enabled", node.isEnabled())
                .put("focused", node.isFocused())
                .put("actions", actions);
        output.put(item);
        records.add(new ProgramNode(handle, new ArrayList<>(path), nodeFingerprint(node)));
        if (node.isPassword()) return;
        for (int index = 0; index < node.getChildCount() && records.size() < 128; index++) {
            path.add(index);
            collectNodes(node.getChild(index), path, output, records, depth + 1);
            path.remove(path.size() - 1);
        }
    }

    private static AccessibilityNodeInfo followPath(AccessibilityNodeInfo root, List<Integer> path) {
        AccessibilityNodeInfo current = root;
        for (Integer index : path) {
            if (current == null || index < 0 || index >= current.getChildCount()) return null;
            current = current.getChild(index);
        }
        return current;
    }

    private static boolean liveStructureMatches(
            AccessibilityNodeInfo root,
            ProgramObservation observation
    ) {
        List<ProgramNode> liveNodes = new ArrayList<>();
        try {
            // Handles and the public observation body are intentionally discarded.
            // ProgramNode contains only the stable path and semantic fingerprint used here.
            collectNodes(root, new ArrayList<>(), new JSONArray(), liveNodes, 0);
            return observation.structuralFingerprint.equals(structuralFingerprint(liveNodes));
        } catch (JSONException error) {
            return false;
        }
    }

    private static String structuralFingerprint(List<ProgramNode> records) {
        StringBuilder material = new StringBuilder();
        for (ProgramNode record : records) {
            for (Integer index : record.path) material.append(index).append('/');
            material.append(':').append(record.fingerprint).append('\n');
        }
        return MoaProgramJson.sha256(material.toString());
    }

    private static String nodeFingerprint(AccessibilityNodeInfo node) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        String source = bounded(node.getClassName(), 120) + "\n"
                + bounded(node.getViewIdResourceName(), 200) + "\n"
                + (node.isPassword() || node.isEditable() ? "[redacted]" : boundedLabel(node.getContentDescription(), node.getText())) + "\n"
                + bounds.flattenToString() + "\n"
                + node.isClickable() + "\n"
                + node.isEditable() + "\n"
                + node.isScrollable() + "\n"
                + node.isPassword() + "\n"
                + node.isEnabled() + "\n"
                + node.isFocused() + "\n"
                + node.getChildCount();
        return MoaProgramJson.sha256(source);
    }

    private static String boundedLabel(CharSequence first, CharSequence second) {
        String value = bounded(first, 240);
        return value.isEmpty() ? bounded(second, 240) : value;
    }

    private static String bounded(CharSequence value, int max) {
        if (value == null) return "";
        String text = value.toString()
                .replaceAll("[\\r\\n\\t]+", " ")
                .replaceAll("\\s+", " ")
                .trim();
        return text.length() <= max ? text : text.substring(0, max);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.US);
    }

    private static final class ProgramObservation {
        final JSONObject body;
        final List<ProgramNode> nodes;
        final String structuralFingerprint;
        final long expiresAtMs;

        ProgramObservation(
                JSONObject body,
                List<ProgramNode> nodes,
                String structuralFingerprint,
                long expiresAtMs
        ) {
            this.body = body;
            this.nodes = nodes;
            this.structuralFingerprint = structuralFingerprint;
            this.expiresAtMs = expiresAtMs;
        }

        ProgramNode find(String handle) {
            for (ProgramNode node : nodes) {
                if (node.handle.equals(handle)) return node;
            }
            return null;
        }
    }

    private static final class ProgramNode {
        final String handle;
        final List<Integer> path;
        final String fingerprint;

        ProgramNode(String handle, List<Integer> path, String fingerprint) {
            this.handle = handle;
            this.path = path;
            this.fingerprint = fingerprint;
        }
    }

    static class ProgramActionResult {
        final boolean success;
        final String status;
        final String code;
        final String summary;
        final JSONObject data;
        final String postStateSha256;

        ProgramActionResult(
                boolean success,
                String status,
                String code,
                String summary,
                JSONObject data,
                String postStateSha256
        ) {
            this.success = success;
            this.status = status;
            this.code = code;
            this.summary = summary;
            this.data = data;
            this.postStateSha256 = postStateSha256;
        }

        static ProgramActionResult success(String summary, JSONObject data) {
            return success(summary, data, null);
        }

        static ProgramActionResult success(String summary, JSONObject data, String postState) {
            return new ProgramActionResult(true, "succeeded", "", summary, data, postState);
        }

        static ProgramActionResult failed(String summary) {
            return new ProgramActionResult(false, "failed", "action_failed", summary, null, null);
        }

        static ProgramActionResult stale(String summary) {
            return new ProgramActionResult(false, "stale_state", "stale_state", summary, null, null);
        }

        static ProgramActionResult rejected(String code, String summary) {
            return new ProgramActionResult(false, "rejected", code, summary, null, null);
        }

        static ProgramActionResult indeterminate() {
            return new ProgramActionResult(
                    false,
                    "indeterminate",
                    "indeterminate",
                    "Accessibility effect outcome is indeterminate.",
                    null,
                    null
            );
        }
    }
}

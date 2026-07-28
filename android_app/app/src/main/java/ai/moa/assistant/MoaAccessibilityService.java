package ai.moa.assistant;

import android.accessibilityservice.AccessibilityService;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.text.InputType;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class MoaAccessibilityService extends AccessibilityService {
    private static final int MAX_SUMMARY_CHARS = 1800;
    private static final int MAX_NODE_TEXTS = 44;
    private static volatile MoaAccessibilityService activeService;
    private static volatile String latestSummary = "";
    private static volatile String latestPackage = "";
    private static volatile String latestClass = "";
    private static volatile long latestUpdatedAtMs = 0L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile MoaYoutubeAccessibilityExecutor youtubeExecutor;
    private volatile long clipboardGeneration;
    private ClipboardManager clipboardManager;
    private final ClipboardManager.OnPrimaryClipChangedListener clipboardListener =
            () -> clipboardGeneration++;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        activeService = this;
        clipboardManager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboardManager != null) clipboardManager.addPrimaryClipChangedListener(clipboardListener);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        activeService = this;
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
        if (youtubeExecutor != null) {
            youtubeExecutor.onAccessibilityEvent();
        }
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(Intent intent) {
        cancelYoutubeOperation();
        removeClipboardListener();
        if (activeService == this) {
            activeService = null;
        }
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        cancelYoutubeOperation();
        removeClipboardListener();
        if (activeService == this) {
            activeService = null;
        }
        super.onDestroy();
    }

    private void removeClipboardListener() {
        if (clipboardManager != null) clipboardManager.removePrimaryClipChangedListener(clipboardListener);
        clipboardManager = null;
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
        JSONObject descriptor = MoaActiveAppDescriptor.create(
                isRunning(),
                latestPackage,
                latestClass,
                latestUpdatedAtMs,
                System.currentTimeMillis()
        );
        try {
            int windowId = currentActiveWindowId();
            descriptor.put("window_id", windowId >= 0 ? windowId : JSONObject.NULL);
        } catch (JSONException ignored) {
        }
        return descriptor;
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

    static int currentActiveWindowId() {
        MoaAccessibilityService service = activeService;
        AccessibilityNodeInfo root = service == null ? null : service.getRootInActiveWindow();
        return root == null ? -1 : root.getWindowId();
    }

    static String freshActivePackage() {
        MoaAccessibilityService service = activeService;
        AccessibilityNodeInfo root = service == null ? null : service.getRootInActiveWindow();
        CharSequence packageName = root == null ? null : root.getPackageName();
        return packageName == null ? "" : packageName.toString().trim();
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

    static SemanticActionResult setTextByLabel(
            String label, String value, String expectedPackage, int expectedWindowId) {
        MoaAccessibilityService service = activeService;
        AccessibilityNodeInfo root = validatedRoot(service, expectedPackage, expectedWindowId);
        if (root == null) {
            return service == null ? SemanticActionResult.UNAVAILABLE : SemanticActionResult.STALE_TARGET;
        }
        AccessibilityNodeInfo match = findMatchingNode(root, normalize(label));
        AccessibilityNodeInfo editable = nearbyEditable(match);
        if (editable == null) return SemanticActionResult.NOT_FOUND;
        Bundle arguments = new Bundle();
        arguments.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        return editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
                ? SemanticActionResult.PERFORMED : SemanticActionResult.FAILED;
    }

    static SemanticActionResult scrollByLabel(
            String label, boolean forward, String expectedPackage, int expectedWindowId) {
        MoaAccessibilityService service = activeService;
        AccessibilityNodeInfo root = validatedRoot(service, expectedPackage, expectedWindowId);
        if (root == null) {
            return service == null ? SemanticActionResult.UNAVAILABLE : SemanticActionResult.STALE_TARGET;
        }
        AccessibilityNodeInfo match = findMatchingNode(root, normalize(label));
        AccessibilityNodeInfo scrollable = nearbyScrollable(match);
        if (scrollable == null) return SemanticActionResult.NOT_FOUND;
        int action = forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
        return scrollable.performAction(action)
                ? SemanticActionResult.PERFORMED : SemanticActionResult.FAILED;
    }

    private static AccessibilityNodeInfo validatedRoot(
            MoaAccessibilityService service, String expectedPackage, int expectedWindowId) {
        if (service == null || expectedWindowId < 0 || normalize(expectedPackage).isEmpty()) return null;
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null || root.getPackageName() == null
                || root.getWindowId() != expectedWindowId
                || !MoaActiveAppDescriptor.packageMatches(
                        expectedPackage, root.getPackageName().toString())) return null;
        return root;
    }

    enum SemanticActionResult {
        PERFORMED,
        STALE_TARGET,
        NOT_FOUND,
        FAILED,
        UNAVAILABLE
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

    static synchronized YoutubeStartResult executeYoutubeOperation(
            MoaYoutubeAccessibilityExecutor.Request request,
            MoaYoutubeAccessibilityExecutor.Callback callback
    ) {
        MoaAccessibilityService service = activeService;
        if (service == null || request == null || callback == null) {
            return YoutubeStartResult.UNAVAILABLE;
        }
        if (service.youtubeExecutor != null) {
            return YoutubeStartResult.BUSY;
        }
        YoutubeDriver driver = new YoutubeDriver(service);
        final MoaYoutubeAccessibilityExecutor[] holder = new MoaYoutubeAccessibilityExecutor[1];
        MoaYoutubeAccessibilityExecutor executor = new MoaYoutubeAccessibilityExecutor(
                request,
                driver,
                result -> {
                    if (service.youtubeExecutor == holder[0]) {
                        service.youtubeExecutor = null;
                    }
                    callback.onTerminal(result);
                }
        );
        holder[0] = executor;
        service.youtubeExecutor = executor;
        service.mainHandler.post(executor::start);
        return YoutubeStartResult.STARTED;
    }

    static void cancelActiveYoutubeOperation() {
        MoaAccessibilityService service = activeService;
        if (service != null) {
            service.cancelYoutubeOperation();
        }
    }

    enum YoutubeStartResult {
        STARTED,
        BUSY,
        UNAVAILABLE
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

    private static AccessibilityNodeInfo nearbyEditable(AccessibilityNodeInfo node) {
        return MoaSemanticNodeResolver.nearby(node, nodeAccess(true));
    }

    private static AccessibilityNodeInfo nearbyScrollable(AccessibilityNodeInfo node) {
        return MoaSemanticNodeResolver.nearby(node, nodeAccess(false));
    }

    private static MoaSemanticNodeResolver.Access<AccessibilityNodeInfo> nodeAccess(
            boolean editable) {
        return new MoaSemanticNodeResolver.Access<AccessibilityNodeInfo>() {
            @Override public AccessibilityNodeInfo parent(AccessibilityNodeInfo node) {
                return node.getParent();
            }
            @Override public int childCount(AccessibilityNodeInfo node) {
                return node.getChildCount();
            }
            @Override public AccessibilityNodeInfo childAt(AccessibilityNodeInfo node, int index) {
                return node.getChild(index);
            }
            @Override public boolean eligible(AccessibilityNodeInfo node) {
                return editable ? node.isEditable() && !isSensitiveTextField(node)
                        : node.isScrollable();
            }
        };
    }

    static boolean isSensitiveTextInput(int inputType, boolean password) {
        if (password) return true;
        int typeClass = inputType & InputType.TYPE_MASK_CLASS;
        int variation = inputType & InputType.TYPE_MASK_VARIATION;
        if (typeClass == InputType.TYPE_CLASS_NUMBER) {
            return variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD;
        }
        return typeClass == InputType.TYPE_CLASS_TEXT
                && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD);
    }

    private static boolean isSensitiveTextField(AccessibilityNodeInfo node) {
        return node == null || isSensitiveTextInput(node.getInputType(), node.isPassword());
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

    private void cancelYoutubeOperation() {
        MoaYoutubeAccessibilityExecutor executor = youtubeExecutor;
        youtubeExecutor = null;
        if (executor != null) {
            executor.cancel();
        }
    }

    private static final class YoutubeDriver implements MoaYoutubeAccessibilityExecutor.Driver {
        private final MoaAccessibilityService service;
        private final Map<String, AccessibilityNodeInfo> currentNodes = new HashMap<>();
        private String snapshotPackage = "";
        private int snapshotWindowId = -1;

        private YoutubeDriver(MoaAccessibilityService service) {
            this.service = service;
        }

        @Override
        public MoaYoutubeAccessibilityExecutor.Snapshot snapshot() {
            AccessibilityNodeInfo root = service.getRootInActiveWindow();
            if (root == null || root.getPackageName() == null) {
                return null;
            }
            snapshotPackage = root.getPackageName().toString();
            snapshotWindowId = root.getWindowId();
            currentNodes.clear();
            List<MoaYoutubeAccessibilityExecutor.Node> nodes = new ArrayList<>();
            collect(root, "0", "", nodes, 0);
            MoaMediaSessionController.Snapshot media =
                    new MoaMediaSessionController(service).currentSnapshot(snapshotPackage);
            return youtubeSnapshot(snapshotPackage, snapshotWindowId, nodes, media);
        }

        @Override
        public boolean click(String localId) {
            AccessibilityNodeInfo node = validatedNode(localId);
            return node != null && node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }

        @Override
        public boolean setText(String localId, String value) {
            AccessibilityNodeInfo node = validatedNode(localId);
            if (node == null || !node.isEditable()) {
                return false;
            }
            Bundle arguments = new Bundle();
            arguments.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    value
            );
            return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        }

        @Override
        public boolean scrollForward(String localId) {
            AccessibilityNodeInfo node = validatedNode(localId);
            return node != null && node.isScrollable()
                    && node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
        }

        @Override
        public boolean back() {
            return service.performGlobalAction(GLOBAL_ACTION_BACK);
        }

        @Override
        public String clipboardText() {
            ClipboardManager clipboard = (ClipboardManager) service.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip() || clipboard.getPrimaryClip() == null
                    || clipboard.getPrimaryClip().getItemCount() != 1) {
                return "";
            }
            CharSequence value = clipboard.getPrimaryClip().getItemAt(0).coerceToText(service);
            return value == null ? "" : value.toString();
        }

        @Override
        public long clipboardGeneration() {
            return service.clipboardGeneration;
        }

        @Override
        public long nowMs() {
            return System.currentTimeMillis();
        }

        @Override
        public void postDelayed(Runnable runnable, long delayMs) {
            service.mainHandler.postDelayed(runnable, Math.max(0L, delayMs));
        }

        private void collect(
                AccessibilityNodeInfo node,
                String localId,
                String parentId,
                List<MoaYoutubeAccessibilityExecutor.Node> output,
                int depth
        ) {
            if (node == null || depth > 12 || output.size() >= MoaYoutubeAccessibilityExecutor.MAX_NODES + 1) {
                return;
            }
            currentNodes.put(localId, node);
            output.add(new MoaYoutubeAccessibilityExecutor.Node(
                    localId,
                    parentId,
                    string(node.getViewIdResourceName()),
                    string(node.getText()),
                    string(node.getContentDescription()),
                    node.isClickable(),
                    node.isEditable(),
                    node.isScrollable(),
                    node.isCheckable() && node.isChecked()
            ));
            for (int index = 0; index < node.getChildCount(); index++) {
                collect(node.getChild(index), localId + "." + index, localId, output, depth + 1);
                if (output.size() > MoaYoutubeAccessibilityExecutor.MAX_NODES) {
                    return;
                }
            }
        }

        private AccessibilityNodeInfo validatedNode(String localId) {
            AccessibilityNodeInfo root = service.getRootInActiveWindow();
            if (root == null || root.getPackageName() == null
                    || !snapshotPackage.equals(root.getPackageName().toString())
                    || snapshotWindowId != root.getWindowId()) {
                return null;
            }
            AccessibilityNodeInfo node = currentNodes.get(localId);
            return node != null && node.getWindowId() == snapshotWindowId ? node : null;
        }

        private static String string(CharSequence value) {
            return value == null ? "" : value.toString();
        }
    }

    static MoaYoutubeAccessibilityExecutor.Snapshot youtubeSnapshot(
            String packageName, int windowId, List<MoaYoutubeAccessibilityExecutor.Node> nodes,
            MoaMediaSessionController.Snapshot media) {
        String videoId = media == null ? "" : MoaYoutubeUiPolicy.extractVideoId(
                media.mediaId.isEmpty() ? media.mediaUri : media.mediaId);
        boolean bound = media != null && packageName.equals(media.packageName)
                && MoaMediaSpotStore.isValidYouTubeVideoId(videoId) && !media.title.isEmpty();
        return new MoaYoutubeAccessibilityExecutor.Snapshot(packageName,
                MoaYoutubeUiPolicy.profileForPackage(packageName) == null ? ""
                        : MoaYoutubeUiPolicy.profileForPackage(packageName).version,
                bound ? videoId : "", bound ? media.title : "",
                bound ? media.mediaFingerprint : "", windowId, nodes);
    }
}

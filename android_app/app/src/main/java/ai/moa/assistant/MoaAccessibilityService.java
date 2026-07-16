package ai.moa.assistant;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

public final class MoaAccessibilityService extends AccessibilityService {
    private static final int MAX_SUMMARY_CHARS = 1800;
    private static final int MAX_NODE_TEXTS = 44;
    private static final String SECURE_CONTENT_MARKER = "[secure content omitted]";
    private static final MoaScreenContextCache SCREEN_CACHE = new MoaScreenContextCache();
    private static volatile MoaAccessibilityService activeService;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        SCREEN_CACHE.clear();
        activeService = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        activeService = this;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) {
            SCREEN_CACHE.clear();
            return;
        }

        StringBuilder builder = new StringBuilder();
        String packageName = root.getPackageName() == null ? "" : root.getPackageName().toString();
        String className = event == null || event.getClassName() == null
                ? ""
                : event.getClassName().toString();
        if (!packageName.isEmpty()) {
            builder.append("Package: ").append(packageName).append('\n');
        }
        if (!className.isEmpty()) {
            builder.append("Class: ").append(className).append('\n');
        }
        builder.append("Visible text: ");

        boolean[] secureContent = new boolean[]{false};
        collectNodeText(root, builder, new HashSet<>(), new int[]{0}, secureContent);
        String summary = builder.toString().trim();
        if (summary.length() > MAX_SUMMARY_CHARS) {
            summary = summary.substring(0, MAX_SUMMARY_CHARS).trim();
        }
        SCREEN_CACHE.update(packageName, className, summary, System.currentTimeMillis(), secureContent[0]);
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (activeService == this) {
            activeService = null;
            SCREEN_CACHE.clear();
        }
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        if (activeService == this) {
            activeService = null;
            SCREEN_CACHE.clear();
        }
        super.onDestroy();
    }

    static boolean isRunning() {
        return activeService != null;
    }

    static void captureScreenshot(
            MoaScreenshotPolicy.Request request,
            MoaScreenshotCaptureAdapter.Callback callback
    ) {
        new MoaScreenshotCaptureAdapter(activeService).capture(request, callback);
    }

    static String currentScreenSummary() {
        return latestScreenSummary();
    }

    static JSONObject currentScreenSnapshot() {
        if (!isRunning()) {
            return null;
        }

        MoaScreenContextCache.Snapshot cached = SCREEN_CACHE.read();
        if (!cached.available()) {
            return null;
        }
        JSONObject snapshot = new JSONObject();
        try {
            snapshot.put("running", true);
            snapshot.put("available", true);
            snapshot.put("package", cached.packageName);
            snapshot.put("class", cached.className);
            snapshot.put("updated_at_ms", cached.updatedAtMs);
            snapshot.put("summary", cached.summary.trim());
            snapshot.put("secure_content", cached.secureContent);
            snapshot.put("active_app", currentActiveAppDescriptor());
        } catch (JSONException ignored) {
        }
        return snapshot;
    }

    static JSONObject currentActiveAppDescriptor() {
        MoaScreenContextCache.Snapshot cached = SCREEN_CACHE.read();
        return MoaActiveAppDescriptor.create(
                isRunning(),
                cached.packageName,
                cached.className,
                cached.updatedAtMs,
                System.currentTimeMillis()
        );
    }

    static JSONArray currentExecutionAdapters() {
        MoaScreenContextCache.Snapshot cached = SCREEN_CACHE.read();
        return MoaActiveAppDescriptor.executionAdapters(
                isRunning(),
                cached.packageName,
                cached.className,
                cached.updatedAtMs,
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

    static String latestScreenSummary() {
        return SCREEN_CACHE.read().summary.trim();
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

    private static void collectNodeText(
            AccessibilityNodeInfo node,
            StringBuilder builder,
            Set<String> seen,
            int[] count,
            boolean[] secureContent
    ) {
        if (node == null || count[0] >= MAX_NODE_TEXTS || builder.length() >= MAX_SUMMARY_CHARS) {
            return;
        }

        if (node.isPassword()) {
            secureContent[0] = true;
            appendText(builder, seen, count, SECURE_CONTENT_MARKER);
            return;
        }

        CharSequence text = node.getText();
        CharSequence description = node.getContentDescription();
        appendText(builder, seen, count, text);
        appendText(builder, seen, count, description);

        for (int i = 0; i < node.getChildCount(); i++) {
            collectNodeText(node.getChild(i), builder, seen, count, secureContent);
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

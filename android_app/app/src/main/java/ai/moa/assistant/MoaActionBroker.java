package ai.moa.assistant;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class MoaActionBroker {
    private static final String RISK_READ_ONLY = "read_only";
    private static final String RISK_NAVIGATION = "navigation";
    private static final String APPROVAL_IMPLICIT = "implicit_user_command";
    private static final Map<String, Capability> CAPABILITIES = createCapabilityManifest();

    private final Context context;

    MoaActionBroker(Context context) {
        this.context = context.getApplicationContext();
    }

    LocalActionResult tryHandleLocalCommand(String text) {
        String trimmed = safe(text);
        String lower = trimmed.toLowerCase(Locale.US);

        if (lower.equals("/screen")) {
            Capability capability = CAPABILITIES.get("screen.summary");
            if (!MoaAccessibilityService.isRunning()) {
                return LocalActionResult.handled("Screen access is not running. Open Aggie and enable screen access in Android accessibility settings.");
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
            boolean clicked = MoaAccessibilityService.clickByText(label);
            if (clicked) {
                recordReceipt(capability, label, true, "Tapped visible label.");
                return LocalActionResult.handled("Tapped \"" + label + "\".");
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

        String appTarget = openAppTarget(trimmed);
        if (!appTarget.isEmpty()) {
            return openLauncherApp(appTarget);
        }

        return LocalActionResult.notHandled();
    }

    JSONObject screenSnapshot() {
        return MoaAccessibilityService.currentScreenSnapshot();
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

    boolean rejectsModelProposal(JSONObject proposal) {
        if (proposal == null) {
            return true;
        }
        String tool = safe(proposal.optString("tool", proposal.optString("name", "")));
        Capability capability = CAPABILITIES.get(tool);
        return capability == null || "blocked".equals(capability.approval);
    }

    private void recordReceipt(Capability capability, String target, boolean success, String result) {
        if (capability == null) {
            return;
        }
        MoaActionReceiptStore.record(context, capability.tool, capability.risk, capability.approval, target, success, result);
    }

    private LocalActionResult openLauncherApp(String target) {
        Capability capability = CAPABILITIES.get("app.launch");
        PackageManager packageManager = context.getPackageManager();
        List<AppCandidate> matches = matchingLauncherApps(packageManager, target);
        if (matches.isEmpty()) {
            recordReceipt(capability, target, false, "No matching launcher app.");
            return LocalActionResult.handled("I could not find an installed app matching \"" + target + "\".");
        }
        if (matches.size() > 1) {
            StringBuilder names = new StringBuilder();
            for (int i = 0; i < Math.min(matches.size(), 4); i += 1) {
                if (i > 0) {
                    names.append(", ");
                }
                names.append(matches.get(i).label);
            }
            recordReceipt(capability, target, false, "Multiple launcher app matches.");
            return LocalActionResult.handled("I found multiple apps matching \"" + target + "\": " + names + ". Say the full app name.");
        }

        AppCandidate app = matches.get(0);
        Intent launchIntent = packageManager.getLaunchIntentForPackage(app.packageName);
        if (launchIntent == null) {
            launchIntent = new Intent(Intent.ACTION_MAIN);
            launchIntent.addCategory(Intent.CATEGORY_LAUNCHER);
            launchIntent.setClassName(app.packageName, app.activityName);
        }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(launchIntent);
            recordReceipt(capability, app.label, true, "Opened launcher app.");
            return LocalActionResult.handled("Opened " + app.label + ".");
        } catch (RuntimeException error) {
            recordReceipt(capability, app.label, false, "Launch failed.");
            return LocalActionResult.handled("I could not open " + app.label + ".");
        }
    }

    private static List<AppCandidate> matchingLauncherApps(PackageManager packageManager, String target) {
        String normalizedTarget = normalizeAppLabel(target);
        if (normalizedTarget.isEmpty()) {
            return Collections.emptyList();
        }

        Intent launcherIntent = new Intent(Intent.ACTION_MAIN);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> activities = packageManager.queryIntentActivities(launcherIntent, 0);
        List<AppCandidate> exact = new ArrayList<>();
        List<AppCandidate> fuzzy = new ArrayList<>();
        for (ResolveInfo info : activities) {
            if (info == null || info.activityInfo == null) {
                continue;
            }
            String packageName = safe(info.activityInfo.packageName);
            String activityName = safe(info.activityInfo.name);
            CharSequence loadedLabel = info.loadLabel(packageManager);
            String label = safe(loadedLabel == null ? "" : loadedLabel.toString());
            String normalizedLabel = normalizeAppLabel(label);
            String normalizedPackage = normalizeAppLabel(packageName);
            AppCandidate candidate = new AppCandidate(label.isEmpty() ? packageName : label, packageName, activityName);
            if (normalizedLabel.equals(normalizedTarget) || normalizedPackage.equals(normalizedTarget)) {
                exact.add(candidate);
            } else if (normalizedLabel.contains(normalizedTarget) || normalizedPackage.contains(normalizedTarget)) {
                fuzzy.add(candidate);
            }
        }
        return exact.isEmpty() ? fuzzy : exact;
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

    static String normalizeAppLabel(String value) {
        return safe(value)
                .toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9]+", " ")
                .trim();
    }

    private static Map<String, Capability> createCapabilityManifest() {
        Map<String, Capability> capabilities = new HashMap<>();
        capabilities.put("screen.summary", new Capability("screen.summary", RISK_READ_ONLY, "none"));
        capabilities.put("screen.tap_text", new Capability("screen.tap_text", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.back", new Capability("system.back", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.home", new Capability("system.home", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("app.launch", new Capability("app.launch", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("external.side_effect", new Capability("external.side_effect", "external_side_effect", "confirm"));
        capabilities.put("sensitive.side_effect", new Capability("sensitive.side_effect", "sensitive_side_effect", "blocked"));
        return Collections.unmodifiableMap(capabilities);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
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

    private static final class AppCandidate {
        final String label;
        final String packageName;
        final String activityName;

        AppCandidate(String label, String packageName, String activityName) {
            this.label = label;
            this.packageName = packageName;
            this.activityName = activityName;
        }
    }
}

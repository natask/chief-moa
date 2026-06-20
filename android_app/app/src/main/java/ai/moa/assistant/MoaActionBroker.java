package ai.moa.assistant;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.HashMap;
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

    private static Map<String, Capability> createCapabilityManifest() {
        Map<String, Capability> capabilities = new HashMap<>();
        capabilities.put("screen.summary", new Capability("screen.summary", RISK_READ_ONLY, "none"));
        capabilities.put("screen.tap_text", new Capability("screen.tap_text", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.back", new Capability("system.back", RISK_NAVIGATION, APPROVAL_IMPLICIT));
        capabilities.put("system.home", new Capability("system.home", RISK_NAVIGATION, APPROVAL_IMPLICIT));
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
}

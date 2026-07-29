package ag.companion;

import org.json.JSONObject;

import java.util.Locale;
import java.util.Set;

/** Closed semantic Accessibility operations shared by the local action broker. */
final class MoaSemanticAccessibilityActions {
    private MoaSemanticAccessibilityActions() {}

    static String expectedPackage(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return safe(args.optString("expected_package", args.optString("expectedPackage", "")));
    }

    static int expectedWindowId(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        return args.optInt("expected_window_id", args.optInt("expectedWindowId", -1));
    }

    static String label(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        String value = safe(args.optString("label", args.optString("target", "")));
        return value.length() <= 160 ? value : "";
    }

    static String text(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        if (!args.has("text") && !args.has("value")) return null;
        String value = args.optString("text", args.optString("value", ""));
        return value != null && value.length() <= 4096 ? value : null;
    }

    static boolean sensitiveLabel(String value) {
        String label = safe(value).toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9]+", " ").trim();
        return label.matches(".*\\b(password|passcode|pin|cvv|cvc|otp)\\b.*")
                || label.contains("security code") || label.contains("one time code");
    }

    static Boolean scrollForward(JSONObject input) {
        JSONObject args = input == null ? new JSONObject() : input;
        String direction = safe(args.optString("direction", "forward")).toLowerCase(Locale.US);
        if (Set.of("forward", "down", "next").contains(direction)) return true;
        if (Set.of("backward", "up", "previous").contains(direction)) return false;
        return null;
    }

    static Outcome prepareSetText(
            String requestId, JSONObject args, MoaActionApprovalController approvals) {
        String label = label(args);
        String value = text(args);
        String expectedPackage = expectedPackage(args);
        int windowId = expectedWindowId(args);
        if (safe(requestId).isEmpty() || label.isEmpty() || value == null
                || expectedPackage.isEmpty() || windowId < 0) {
            return new Outcome(false,
                    "screen.set_text requires bounded label/text plus expected_package and expected_window_id.");
        }
        if (sensitiveLabel(label)) {
            return new Outcome(false,
                    "Ag cannot enter passwords, passcodes, PINs, or security codes.");
        }
        if (!MoaActiveAppDescriptor.packageMatches(
                expectedPackage, MoaAccessibilityService.freshActivePackage())
                || windowId != MoaAccessibilityService.currentActiveWindowId()) {
            return new Outcome(false, "The target screen changed; text was not entered.");
        }
        try {
            long now = System.currentTimeMillis();
            approvals.bind(requestId, "screen.set_text", args, expectedPackage, now, now + 120_000L);
            return new Outcome(true,
                    "Allow Ag to enter text in \"" + label + "\" in " + expectedPackage + "?");
        } catch (RuntimeException error) {
            return new Outcome(false, "Text-entry approval could not be created.");
        }
    }

    static Outcome setText(JSONObject args) {
        String label = label(args);
        String value = text(args);
        int windowId = expectedWindowId(args);
        if (value == null || windowId != MoaAccessibilityService.currentActiveWindowId()) {
            return new Outcome(false, "Active window changed before approved text entry.");
        }
        MoaAccessibilityService.SemanticActionResult result = MoaAccessibilityService.setTextByLabel(
                label, value, expectedPackage(args), windowId);
        return outcome(result, "Entered text in the approved field.", "Text entry stopped");
    }

    static Outcome scroll(JSONObject args) {
        String label = label(args);
        String expectedPackage = expectedPackage(args);
        int windowId = expectedWindowId(args);
        Boolean forward = scrollForward(args);
        if (label.isEmpty() || expectedPackage.isEmpty() || windowId < 0 || forward == null) {
            return new Outcome(false, "screen.scroll requires label, direction, expected_package, and expected_window_id.");
        }
        MoaAccessibilityService.SemanticActionResult result = MoaAccessibilityService.scrollByLabel(
                label, forward, expectedPackage, windowId);
        return outcome(result, "Scrolled the matched container.", "Scroll stopped");
    }

    private static Outcome outcome(MoaAccessibilityService.SemanticActionResult result,
            String success, String failure) {
        boolean performed = result == MoaAccessibilityService.SemanticActionResult.PERFORMED;
        return new Outcome(performed, performed ? success
                : failure + ": " + result.name().toLowerCase(Locale.US) + ".");
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    static final class Outcome {
        final boolean success;
        final String summary;

        Outcome(boolean success, String summary) {
            this.success = success;
            this.summary = summary;
        }
    }
}

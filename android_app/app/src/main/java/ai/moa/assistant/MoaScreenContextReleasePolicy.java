package ai.moa.assistant;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

/** Pure final-release gate for legacy semantic context accompanying an Ask capture. */
final class MoaScreenContextReleasePolicy {
    private static final long MAX_BINDING_AGE_MS = MoaScreenshotPolicy.MAX_OBSERVATION_AGE_MS;

    private MoaScreenContextReleasePolicy() {
    }

    static boolean applyCapturedContext(
            JSONObject requestBody,
            JSONObject refreshedSnapshot,
            MoaScreenshotCapture capture
    ) throws JSONException {
        clearScreenContext(requestBody);
        if (capture == null || !releasable(refreshedSnapshot, capture.packageName, capture.capturedAtMs)) {
            return false;
        }
        requestBody.put("screen", refreshedSnapshot);
        return true;
    }

    static boolean applyDeniedContext(
            JSONObject requestBody,
            JSONObject refreshedSnapshot,
            String expectedPackage,
            long nowMs,
            MoaScreenshotPolicy.DenialReason reason
    ) throws JSONException {
        clearScreenContext(requestBody);
        if (!allowsSemanticFallback(reason)
                || !releasable(refreshedSnapshot, expectedPackage, nowMs)) {
            return false;
        }
        requestBody.put("screen", refreshedSnapshot);
        return true;
    }

    static void clearScreenContext(JSONObject requestBody) throws JSONException {
        if (requestBody == null) {
            throw new IllegalArgumentException("request body is required");
        }
        requestBody.remove("screen_evidence");
        requestBody.remove("screen");
        MoaScreenEvidenceEnvelope.markAssistantAsk(requestBody);
    }

    private static boolean allowsSemanticFallback(MoaScreenshotPolicy.DenialReason reason) {
        return reason == MoaScreenshotPolicy.DenialReason.CAPTURE_FAILED
                || reason == MoaScreenshotPolicy.DenialReason.IMAGE_UNAVAILABLE
                || reason == MoaScreenshotPolicy.DenialReason.IMAGE_TOO_LARGE;
    }

    private static boolean releasable(JSONObject snapshot, String expectedPackage, long referenceTimeMs) {
        if (snapshot == null
                || !snapshot.optBoolean("running", false)
                || !snapshot.optBoolean("available", false)
                || snapshot.optBoolean("secure_content", false)) {
            return false;
        }
        String expected = normalizePackage(expectedPackage);
        String actual = normalizePackage(snapshot.optString("package", ""));
        long updatedAtMs = snapshot.optLong("updated_at_ms", 0L);
        if (expected.isEmpty() || !expected.equals(actual) || updatedAtMs <= 0L || referenceTimeMs <= 0L) {
            return false;
        }
        long delta = referenceTimeMs >= updatedAtMs
                ? referenceTimeMs - updatedAtMs
                : updatedAtMs - referenceTimeMs;
        return delta <= MAX_BINDING_AGE_MS;
    }

    private static String normalizePackage(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.US);
    }
}

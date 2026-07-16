package ai.moa.assistant;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.util.Base64;

/** Pure serialization boundary for the gateway's moa.screen-evidence.v1 request. */
final class MoaScreenEvidenceEnvelope {
    private static final int MAX_SEMANTIC_SUMMARY_CHARS = 6000;

    private MoaScreenEvidenceEnvelope() {
    }

    static JSONObject fromCapture(MoaScreenshotCapture capture, String semanticSummary) throws JSONException {
        if (!isValid(capture)) {
            throw new IllegalArgumentException("valid screenshot capture is required");
        }
        byte[] bytes = capture.jpegBytes();
        JSONObject screenshot = new JSONObject();
        screenshot.put("mime_type", "image/jpeg");
        screenshot.put("data_base64", Base64.getEncoder().encodeToString(bytes));
        screenshot.put("bytes", bytes.length);
        screenshot.put("width", capture.width);
        screenshot.put("height", capture.height);
        screenshot.put("sha256", capture.sha256);

        JSONObject binding = new JSONObject();
        binding.put("kind", "package");
        binding.put("id", capture.packageName);
        binding.put("generation", Long.toString(capture.capturedAtMs));

        JSONObject evidence = new JSONObject();
        evidence.put("version", "moa.screen-evidence.request.v1");
        evidence.put("surface", "android");
        evidence.put("captured_at", Instant.ofEpochMilli(capture.capturedAtMs).toString());
        evidence.put("binding", binding);
        evidence.put("semantic_summary", boundedSummary(semanticSummary));
        evidence.put("screenshot", screenshot);
        return evidence;
    }

    static void markAssistantAsk(JSONObject requestBody) throws JSONException {
        if (requestBody == null) {
            throw new IllegalArgumentException("request body is required");
        }
        requestBody.put("delivery_intent", "assistant_response");
    }

    static void attachToAsk(
            JSONObject requestBody,
            MoaScreenshotCapture capture,
            String semanticSummary
    ) throws JSONException {
        markAssistantAsk(requestBody);
        requestBody.put("screen_evidence", fromCapture(capture, semanticSummary));
    }

    static void fallBackWithoutScreenshot(JSONObject requestBody) throws JSONException {
        markAssistantAsk(requestBody);
        requestBody.remove("screen_evidence");
    }

    static String visibleFallback(MoaScreenshotPolicy.DenialReason reason, boolean hasSemanticContext) {
        String scope = hasSemanticContext ? "semantic context only" : "no screen context";
        if (reason == null) {
            return "Screenshot unavailable · Ask sent with " + scope;
        }
        switch (reason) {
            case SECURE_CONTENT:
                return "Secure content protected · Ask sent with " + scope;
            case TARGET_MISMATCH:
            case STALE_OBSERVATION:
                return "Screen changed before capture · Ask sent with " + scope;
            case CONSENT_ALREADY_USED:
                return "Screenshot consent was already used · Ask sent with " + scope;
            case ACCESSIBILITY_UNAVAILABLE:
            case CONSENT_REQUIRED:
                return "Screenshot permission unavailable · Ask sent with " + scope;
            default:
                return "Screenshot failed · Ask sent with " + scope;
        }
    }

    private static boolean isValid(MoaScreenshotCapture capture) {
        if (capture == null
                || capture.packageName.trim().isEmpty()
                || capture.capturedAtMs <= 0L
                || capture.width <= 0
                || capture.height <= 0
                || capture.sha256 == null
                || !capture.sha256.matches("[a-f0-9]{64}")) {
            return false;
        }
        int byteCount = capture.jpegBytes().length;
        return byteCount > 0 && byteCount <= MoaScreenshotPolicy.MAX_ENCODED_BYTES;
    }

    private static String boundedSummary(String value) {
        String safe = value == null ? "" : value.trim();
        return safe.length() <= MAX_SEMANTIC_SUMMARY_CHARS
                ? safe
                : safe.substring(0, MAX_SEMANTIC_SUMMARY_CHARS);
    }
}

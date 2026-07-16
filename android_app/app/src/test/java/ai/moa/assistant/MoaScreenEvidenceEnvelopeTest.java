package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class MoaScreenEvidenceEnvelopeTest {
    private static final String DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    @Test
    public void serializesGatewayCompatibleEphemeralEvidence() throws Exception {
        MoaScreenshotCapture capture = new MoaScreenshotCapture(
                new byte[]{1, 2, 3}, "com.example.editor", 1_000L, 2, 1, DIGEST);

        JSONObject evidence = MoaScreenEvidenceEnvelope.fromCapture(capture, "  Current editor text  ");

        assertEquals("moa.screen-evidence.request.v1", evidence.getString("version"));
        assertEquals("android", evidence.getString("surface"));
        assertEquals("1970-01-01T00:00:01Z", evidence.getString("captured_at"));
        assertEquals("Current editor text", evidence.getString("semantic_summary"));
        assertEquals("package", evidence.getJSONObject("binding").getString("kind"));
        assertEquals("com.example.editor", evidence.getJSONObject("binding").getString("id"));
        assertEquals("1000", evidence.getJSONObject("binding").getString("generation"));
        JSONObject screenshot = evidence.getJSONObject("screenshot");
        assertEquals("image/jpeg", screenshot.getString("mime_type"));
        assertEquals("AQID", screenshot.getString("data_base64"));
        assertEquals(3, screenshot.getInt("bytes"));
        assertEquals(2, screenshot.getInt("width"));
        assertEquals(1, screenshot.getInt("height"));
        assertEquals(DIGEST, screenshot.getString("sha256"));
    }

    @Test
    public void boundsSemanticSummaryAndAcceptsNullSummary() throws Exception {
        MoaScreenshotCapture capture = validCapture();
        char[] chars = new char[6002];
        Arrays.fill(chars, 'x');

        assertEquals(6000, MoaScreenEvidenceEnvelope.fromCapture(capture, new String(chars))
                .getString("semantic_summary").length());
        assertEquals("", MoaScreenEvidenceEnvelope.fromCapture(capture, null)
                .getString("semantic_summary"));
    }

    @Test
    public void invalidCaptureShapesFailClosed() {
        assertThrows(IllegalArgumentException.class, () -> MoaScreenEvidenceEnvelope.fromCapture(null, "summary"));
        assertInvalid(new MoaScreenshotCapture(new byte[]{1}, "", 1L, 1, 1, DIGEST));
        assertInvalid(new MoaScreenshotCapture(new byte[]{1}, "pkg", 0L, 1, 1, DIGEST));
        assertInvalid(new MoaScreenshotCapture(new byte[]{1}, "pkg", 1L, 0, 1, DIGEST));
        assertInvalid(new MoaScreenshotCapture(new byte[]{1}, "pkg", 1L, 1, 0, DIGEST));
        assertInvalid(new MoaScreenshotCapture(new byte[]{1}, "pkg", 1L, 1, 1, "bad"));
        assertInvalid(new MoaScreenshotCapture(null, "pkg", 1L, 1, 1, DIGEST));
        assertInvalid(new MoaScreenshotCapture(
                new byte[MoaScreenshotPolicy.MAX_ENCODED_BYTES + 1], "pkg", 1L, 1, 1, DIGEST));
    }

    @Test
    public void fallbackIsVisibleAndDistinguishesSensitiveStaleAndMissingContext() {
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(
                MoaScreenshotPolicy.DenialReason.SECURE_CONTENT, true).startsWith("Secure content protected"));
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(
                MoaScreenshotPolicy.DenialReason.TARGET_MISMATCH, true).startsWith("Screen changed"));
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(
                MoaScreenshotPolicy.DenialReason.STALE_OBSERVATION, true).startsWith("Screen changed"));
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(
                MoaScreenshotPolicy.DenialReason.CONSENT_ALREADY_USED, true).startsWith("Screenshot consent"));
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(
                MoaScreenshotPolicy.DenialReason.ACCESSIBILITY_UNAVAILABLE, true).startsWith("Screenshot permission"));
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(
                MoaScreenshotPolicy.DenialReason.CONSENT_REQUIRED, true).startsWith("Screenshot permission"));
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(
                MoaScreenshotPolicy.DenialReason.CAPTURE_FAILED, true).startsWith("Screenshot failed"));
        assertTrue(MoaScreenEvidenceEnvelope.visibleFallback(null, false).endsWith("no screen context"));
    }

    @Test
    public void askGlueUsesAssistantIntentAndFallbackRemovesPixels() throws Exception {
        JSONObject body = new JSONObject().put("messages", "fixture");
        MoaScreenEvidenceEnvelope.attachToAsk(body, validCapture(), "summary");
        assertEquals("assistant_response", body.getString("delivery_intent"));
        assertTrue(body.has("screen_evidence"));

        MoaScreenEvidenceEnvelope.fallBackWithoutScreenshot(body);
        assertEquals("assistant_response", body.getString("delivery_intent"));
        assertTrue(!body.has("screen_evidence"));
        assertThrows(IllegalArgumentException.class,
                () -> MoaScreenEvidenceEnvelope.markAssistantAsk(null));
    }

    private void assertInvalid(MoaScreenshotCapture capture) {
        assertThrows(IllegalArgumentException.class,
                () -> MoaScreenEvidenceEnvelope.fromCapture(capture, "summary"));
    }

    private MoaScreenshotCapture validCapture() {
        return new MoaScreenshotCapture(new byte[]{1}, "pkg", 1L, 1, 1, DIGEST);
    }
}

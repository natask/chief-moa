package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Regression over the full gate-then-attach sequence used by finishScreenAwareAsk. */
public final class MoaScreenAwareAskFinalizerTest {
    private static final String DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    @Test
    public void callbackPackageMismatchCannotReaddPixelsAfterGateClearsRequest() throws Exception {
        JSONObject body = preloadedBody();

        MoaScreenAwareAskFinalizer.Result result = MoaScreenAwareAskFinalizer.captured(
                body,
                snapshot("other.pkg", 1_000L),
                capture("expected.pkg", 1_000L)
        );

        assertFalse(result.screenshotAttached);
        assertFalse(result.semanticContextAttached);
        assertNoContext(body);
    }

    @Test
    public void callbackStalenessCannotReaddPixelsAfterGateClearsRequest() throws Exception {
        JSONObject body = preloadedBody();

        MoaScreenAwareAskFinalizer.Result result = MoaScreenAwareAskFinalizer.captured(
                body,
                snapshot("expected.pkg", 1_000L),
                capture("expected.pkg", 4_000L)
        );

        assertFalse(result.screenshotAttached);
        assertFalse(result.semanticContextAttached);
        assertNoContext(body);
    }

    @Test
    public void validBoundCallbackAttachesBothCurrentSemanticAndPixels() throws Exception {
        JSONObject body = preloadedBody();

        MoaScreenAwareAskFinalizer.Result result = MoaScreenAwareAskFinalizer.captured(
                body,
                snapshot("expected.pkg", 1_100L),
                capture("expected.pkg", 1_000L)
        );

        assertTrue(result.screenshotAttached);
        assertTrue(result.semanticContextAttached);
        assertTrue(body.has("screen"));
        assertTrue(body.has("screen_evidence"));
        assertTrue("current summary".equals(
                body.getJSONObject("screen_evidence").getString("semantic_summary")));
    }

    @Test
    public void deniedSequencePreservesOnlyEligibleSemanticFallback() throws Exception {
        JSONObject safe = preloadedBody();
        MoaScreenAwareAskFinalizer.Result safeResult = MoaScreenAwareAskFinalizer.denied(
                safe,
                snapshot("expected.pkg", 1_000L),
                "expected.pkg",
                1_100L,
                MoaScreenshotPolicy.DenialReason.CAPTURE_FAILED
        );
        assertFalse(safeResult.screenshotAttached);
        assertTrue(safeResult.semanticContextAttached);
        assertTrue(safe.has("screen"));
        assertFalse(safe.has("screen_evidence"));

        JSONObject mismatch = preloadedBody();
        MoaScreenAwareAskFinalizer.Result mismatchResult = MoaScreenAwareAskFinalizer.denied(
                mismatch,
                snapshot("other.pkg", 1_000L),
                "expected.pkg",
                1_100L,
                MoaScreenshotPolicy.DenialReason.TARGET_MISMATCH
        );
        assertFalse(mismatchResult.screenshotAttached);
        assertFalse(mismatchResult.semanticContextAttached);
        assertNoContext(mismatch);
    }

    private JSONObject preloadedBody() throws Exception {
        return new JSONObject()
                .put("screen", new JSONObject().put("summary", "stale summary"))
                .put("screen_evidence", new JSONObject().put("screenshot", "stale pixels"));
    }

    private JSONObject snapshot(String packageName, long updatedAtMs) throws Exception {
        return new JSONObject()
                .put("running", true)
                .put("available", true)
                .put("secure_content", false)
                .put("package", packageName)
                .put("updated_at_ms", updatedAtMs)
                .put("summary", "current summary");
    }

    private MoaScreenshotCapture capture(String packageName, long capturedAtMs) {
        return new MoaScreenshotCapture(
                new byte[]{1}, packageName, capturedAtMs, 1, 1, DIGEST);
    }

    private void assertNoContext(JSONObject body) {
        assertFalse(body.has("screen"));
        assertFalse(body.has("screen_evidence"));
    }
}

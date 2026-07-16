package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class MoaScreenContextReleasePolicyTest {
    private static final String DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    @Test
    public void passwordOrSecureDenialRemovesPixelsAndLegacySemanticContext() throws Exception {
        JSONObject body = preloadedBody();
        boolean released = MoaScreenContextReleasePolicy.applyDeniedContext(
                body,
                snapshot("pkg", 1_000L, true),
                "pkg",
                1_000L,
                MoaScreenshotPolicy.DenialReason.SECURE_CONTENT
        );

        assertFalse(released);
        assertNoContext(body);
        assertTrue("assistant_response".equals(body.getString("delivery_intent")));
    }

    @Test
    public void missingServiceRemovesPreloadedLegacyScreen() throws Exception {
        JSONObject body = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyDeniedContext(
                body, null, "pkg", 1_000L, MoaScreenshotPolicy.DenialReason.CAPTURE_FAILED));
        assertNoContext(body);
    }

    @Test
    public void appSwitchAndStaleCallbackCannotReleaseSemanticContext() throws Exception {
        JSONObject switched = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyDeniedContext(
                switched,
                snapshot("other.pkg", 1_000L, false),
                "pkg",
                1_000L,
                MoaScreenshotPolicy.DenialReason.TARGET_MISMATCH
        ));
        assertNoContext(switched);

        JSONObject stale = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyCapturedContext(
                stale,
                snapshot("pkg", 1_000L, false),
                capture("pkg", 4_000L)
        ));
        assertNoContext(stale);
    }

    @Test
    public void captureSuccessRequiresMatchingFreshNonSecureSemanticSnapshot() throws Exception {
        JSONObject matching = preloadedBody();
        assertTrue(MoaScreenContextReleasePolicy.applyCapturedContext(
                matching,
                snapshot("PKG", 1_100L, false),
                capture("pkg", 1_000L)
        ));
        assertTrue(matching.has("screen"));
        assertFalse(matching.has("screen_evidence"));

        JSONObject secure = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyCapturedContext(
                secure,
                snapshot("pkg", 1_000L, true),
                capture("pkg", 1_000L)
        ));
        assertNoContext(secure);

        JSONObject wrongPackage = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyCapturedContext(
                wrongPackage,
                snapshot("other", 1_000L, false),
                capture("pkg", 1_000L)
        ));
        assertNoContext(wrongPackage);
    }

    @Test
    public void onlyBoundImageFailureMayFallBackToSafeSemanticContext() throws Exception {
        JSONObject safe = preloadedBody();
        assertTrue(MoaScreenContextReleasePolicy.applyDeniedContext(
                safe,
                snapshot("pkg", 1_000L, false),
                "pkg",
                1_100L,
                MoaScreenshotPolicy.DenialReason.IMAGE_TOO_LARGE
        ));
        assertTrue(safe.has("screen"));
        assertFalse(safe.has("screen_evidence"));

        JSONObject consent = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyDeniedContext(
                consent,
                snapshot("pkg", 1_000L, false),
                "pkg",
                1_100L,
                MoaScreenshotPolicy.DenialReason.CONSENT_ALREADY_USED
        ));
        assertNoContext(consent);
    }

    @Test
    public void invalidSnapshotShapesAndBodyFailClosed() throws Exception {
        JSONObject body = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyDeniedContext(
                body, new JSONObject(), "", 0L, MoaScreenshotPolicy.DenialReason.IMAGE_UNAVAILABLE));
        assertNoContext(body);
        JSONObject nullCapture = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyCapturedContext(
                nullCapture, snapshot("pkg", 1_000L, false), null));
        assertNoContext(nullCapture);

        JSONObject stopped = snapshot("pkg", 1_000L, false).put("running", false);
        JSONObject stoppedBody = preloadedBody();
        assertFalse(MoaScreenContextReleasePolicy.applyDeniedContext(
                stoppedBody, stopped, null, 1_000L, MoaScreenshotPolicy.DenialReason.CAPTURE_FAILED));
        assertNoContext(stoppedBody);
        assertThrows(IllegalArgumentException.class,
                () -> MoaScreenContextReleasePolicy.clearScreenContext(null));
    }

    private JSONObject preloadedBody() throws Exception {
        return new JSONObject()
                .put("screen", new JSONObject().put("summary", "old secret"))
                .put("screen_evidence", new JSONObject().put("screenshot", "old pixels"));
    }

    private JSONObject snapshot(String packageName, long updatedAtMs, boolean secure) throws Exception {
        return new JSONObject()
                .put("running", true)
                .put("available", true)
                .put("package", packageName)
                .put("updated_at_ms", updatedAtMs)
                .put("secure_content", secure)
                .put("summary", secure ? "[secure content omitted]" : "safe semantic context");
    }

    private MoaScreenshotCapture capture(String packageName, long capturedAtMs) {
        return new MoaScreenshotCapture(new byte[]{1}, packageName, capturedAtMs, 1, 1, DIGEST);
    }

    private void assertNoContext(JSONObject body) {
        assertFalse(body.has("screen"));
        assertFalse(body.has("screen_evidence"));
    }
}

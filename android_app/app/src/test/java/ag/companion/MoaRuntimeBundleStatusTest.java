package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public final class MoaRuntimeBundleStatusTest {
    @Test
    public void baseRuntimeRemainsUsableWithoutSigningConfiguration() throws Exception {
        MoaRuntimeBundleStatus status = MoaRuntimeBundleStatus.from(payload(
                new JSONObject().put("schema", "ag.runtime-config-status.v1")
                        .put("state", "base")
                        .put("signing_configured", false)));

        assertEquals("base", status.state);
        assertTrue(status.compatible);
        assertEquals("Base runtime · signing not configured", status.summary());
    }

    @Test
    public void healthyCompatibleBundleHasBoundedVisibleProvenance() throws Exception {
        MoaRuntimeBundleStatus status = MoaRuntimeBundleStatus.from(payload(active("healthy",
                "0.9.0", "1.0.0", true)));

        assertEquals("bundle-1", status.bundleId);
        assertEquals("2.3.4", status.version);
        assertEquals("stable", status.channel);
        assertTrue(status.compatible);
        assertTrue(status.signingConfigured);
        assertEquals("Bundle 2.3.4 · stable · healthy", status.summary());
    }

    @Test
    public void incompatibleBundleIsVisibleButNeverClaimedHealthy() throws Exception {
        MoaRuntimeBundleStatus status = MoaRuntimeBundleStatus.from(payload(active(
                "incompatible_client", "2.0.0", "3.0.0", false)));

        assertFalse(status.compatible);
        assertEquals("Bundle 2.3.4 needs a newer app shell", status.summary());
    }

    @Test
    public void malformedOrContradictoryStatusFailsClosed() throws Exception {
        assertThrows(IllegalArgumentException.class,
                () -> MoaRuntimeBundleStatus.from(new JSONObject()));
        assertThrows(IllegalArgumentException.class,
                () -> MoaRuntimeBundleStatus.from(payload(active(
                        "healthy", "2.0.0", "3.0.0", false))));
    }

    private static JSONObject payload(JSONObject runtimeBundle) throws Exception {
        return new JSONObject().put("runtime",
                new JSONObject().put("runtime_bundle", runtimeBundle));
    }

    private static JSONObject active(String state, String minimum, String maximum,
            boolean compatible) throws Exception {
        return new JSONObject()
                .put("schema", "ag.runtime-config-status.v1")
                .put("state", state)
                .put("signing_configured", true)
                .put("active", new JSONObject()
                        .put("artifact_id", "bundle-1")
                        .put("manifest_digest", "a".repeat(64))
                        .put("compatible", compatible)
                        .put("manifest", new JSONObject()
                                .put("version", "2.3.4")
                                .put("channel", "stable")
                                .put("compatibility", new JSONObject()
                                        .put("protocol", "ag.android.runtime")
                                        .put("min_version", minimum)
                                        .put("max_version", maximum))));
    }
}

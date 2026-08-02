package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceDraftCapabilityTest {
    @Test
    public void readsDeployedVoiceStreamCapabilityShape() throws Exception {
        JSONObject health = new JSONObject("{\"voice_stream\":{\"provider\":{"
                + "\"voice_drafts_v1\":{\"supported\":true}}}}");

        assertTrue(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app", health, 100L).supported);
    }

    @Test
    public void requiresExplicitNestedBooleanCapability() throws Exception {
        long now = 10_000L;
        assertTrue(MoaVoiceDraftCapability.fromHealth(
                "HTTPS://API.AGEE.APP:443/",
                new JSONObject().put("capabilities", new JSONObject().put("voice_drafts_v1", true)),
                now
        ).isFreshFor("https://api.agee.app", now + 1L));

        assertFalse(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app",
                new JSONObject().put("voice_drafts_v1", true),
                now
        ).isFreshFor("https://api.agee.app", now));
        assertFalse(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app",
                new JSONObject().put("capabilities", new JSONObject().put("voice_drafts_v1", "true")),
                now
        ).isFreshFor("https://api.agee.app", now));
    }

    @Test
    public void freshnessRejectsWrongUrlExpiryAndClockRollback() throws Exception {
        MoaVoiceDraftCapability.Snapshot snapshot = MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app/",
                new JSONObject().put("capabilities", new JSONObject().put("voice_drafts_v1", true)),
                50_000L
        );

        assertTrue(snapshot.isFreshFor("https://api.agee.app", 80_000L));
        assertFalse(snapshot.isFreshFor("https://other.example", 50_001L));
        assertFalse(snapshot.isFreshFor("https://api.agee.app", 80_001L));
        assertFalse(snapshot.isFreshFor("https://api.agee.app", 49_999L));
    }
}

package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceDraftCapabilityTest {
    @Test
    public void readsDeployedVoiceStreamCapabilityShape() throws Exception {
        JSONObject health = new JSONObject("{\"voice_stream\":{\"provider\":{"
                + "\"voice_drafts_v1\":{\"supported\":true,"
                + "\"revision\":\"voice_drafts_v1\","
                + "\"state_machine_revision\":\"voice_draft_state.v1\"}}}}");

        assertTrue(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app", health, 100L).supported);
    }

    @Test
    public void requiresExactVersionedCapability() throws Exception {
        long now = 10_000L;
        assertTrue(MoaVoiceDraftCapability.fromHealth(
                "HTTPS://API.AGEE.APP:443/",
                exactHealth(),
                now
        ).isFreshFor("https://api.agee.app", now + 1L));

        assertFalse(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app",
                healthWithCapability(true),
                now
        ).isFreshFor("https://api.agee.app", now));
        assertFalse(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app",
                healthWithCapability(new JSONObject().put("supported", true)),
                now
        ).isFreshFor("https://api.agee.app", now));
        assertFalse(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app",
                healthWithCapability(new JSONObject().put("supported", true)
                        .put("revision", "voice_drafts_v2")
                        .put("state_machine_revision", "voice_draft_state.v1")),
                now
        ).isFreshFor("https://api.agee.app", now));
        assertFalse(MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app",
                healthWithCapability(new JSONObject().put("supported", true)
                        .put("revision", "voice_drafts_v1")
                        .put("state_machine_revision", "voice_draft_state.v2")),
                now
        ).isFreshFor("https://api.agee.app", now));
    }

    @Test
    public void freshnessRejectsWrongUrlExpiryAndClockRollback() throws Exception {
        MoaVoiceDraftCapability.Snapshot snapshot = MoaVoiceDraftCapability.fromHealth(
                "https://api.agee.app/",
                exactHealth(),
                50_000L
        );

        assertTrue(snapshot.isFreshFor("https://api.agee.app", 80_000L));
        assertFalse(snapshot.isFreshFor("https://other.example", 50_001L));
        assertFalse(snapshot.isFreshFor("https://api.agee.app", 80_001L));
        assertFalse(snapshot.isFreshFor("https://api.agee.app", 49_999L));
    }

    private static JSONObject exactHealth() throws Exception {
        return healthWithCapability(new JSONObject().put("supported", true)
                .put("revision", "voice_drafts_v1")
                .put("state_machine_revision", "voice_draft_state.v1"));
    }

    private static JSONObject healthWithCapability(Object capability) throws Exception {
        return new JSONObject().put("voice_stream", new JSONObject().put("provider",
                new JSONObject().put("voice_drafts_v1", capability)));
    }
}

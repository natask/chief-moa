package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.json.JSONObject;
import org.junit.Test;

public final class MoaVoiceDraftWireProtocolTest {
    @Test
    public void draftStartNamesCapabilityWithoutStartingProviderTurn() {
        JSONObject start = MoaVoiceGatewaySocket.buildVoiceDraftStart(
                "session-a", "turn-a", "branch-a", "android-overlay", "phone-a", false);

        assertEquals("session_start", start.optString("type"));
        assertEquals("voice_drafts_v1", start.optJSONObject("voice_draft").optString("version"));
        assertEquals("create", start.optJSONObject("voice_draft").optString("operation"));
        assertFalse(start.has("commit_turn"));
    }

    @Test
    public void everyMutationCarriesExactAuthority() {
        JSONObject event = MoaVoiceGatewaySocket.buildVoiceDraftAuthorityEvent(
                "voice_draft_control", "session-a", "branch-a", "turn-a", "draft-a",
                7L, "pause", "pause-a");

        assertEquals("session-a", event.optString("session_id"));
        assertEquals("branch-a", event.optString("branch_id"));
        assertEquals("turn-a", event.optString("turn_id"));
        assertEquals("draft-a", event.optString("draft_id"));
        assertEquals(7L, event.optLong("expected_revision"));
        assertEquals("pause", event.optString("action"));
        assertEquals("pause-a", event.optString("idempotency_key"));
    }
}

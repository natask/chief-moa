package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaTranscriptReconciliationOptInTest {
    @Test
    public void retainedNormalTurnSendsExactVersionedPrivacyOptIn() throws Exception {
        JSONObject start = MoaVoiceGatewaySocket.applyTranscriptReconciliation(
                new JSONObject().put("type", "session_start"), true);
        JSONObject optIn = start.getJSONObject("transcript_reconciliation");

        assertEquals("continue", start.getString("context_action"));
        assertTrue(optIn.getBoolean("enabled"));
        assertEquals(1, optIn.getInt("version"));
        assertEquals("retained", optIn.getString("privacy_scope"));
    }

    @Test
    public void incognitoOrUnknownRetentionOmitsOptIn() throws Exception {
        JSONObject start = MoaVoiceGatewaySocket.applyTranscriptReconciliation(
                new JSONObject().put("type", "session_start"), false);

        assertFalse(start.has("transcript_reconciliation"));
        assertFalse(start.has("context_action"));
    }

    @Test
    public void draftStartCarriesOptInOnlyWhenExplicitlyRequested() throws Exception {
        JSONObject retained = MoaVoiceGatewaySocket.buildVoiceDraftStart(
                "session", "turn", "default", "android-overlay", "device", false, true);
        JSONObject privateTurn = MoaVoiceGatewaySocket.buildVoiceDraftStart(
                "session", "turn", "default", "android-overlay", "device", false, false);

        assertEquals("retained", retained.getJSONObject("transcript_reconciliation")
                .getString("privacy_scope"));
        assertEquals("continue", retained.getString("context_action"));
        assertFalse(privateTurn.has("transcript_reconciliation"));
        assertFalse(privateTurn.has("context_action"));
    }
}

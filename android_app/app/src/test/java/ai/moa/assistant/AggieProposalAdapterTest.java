package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

public final class AggieProposalAdapterTest {
    @Test public void matchesGatewayGoldenDigestForNAndNMinusOne() throws Exception {
        assertEquals("ad32370b60ef1be2b22fa8a98f31b76bdc1d65a75d30efb444c294c40d4624f6", AggieProposalAdapter.parse(valid(2)).digest);
        assertEquals("369b5bc443289355f8cff928503da4a48c510ecdcb1a4202f4743ce088c07098", AggieProposalAdapter.parse(valid(1)).digest);
    }

    @Test public void acceptsOnlyCompleteAndroidScopeAndClosedTypes() throws Exception {
        JSONObject incomplete = valid(2); incomplete.getJSONObject("surface").remove("device_id"); reject(incomplete, "invalid_shape");
        JSONObject browser = valid(2); browser.getJSONObject("surface").put("kind", "browser"); reject(browser, "surface_not_android");
        JSONObject action = valid(2); action.getJSONObject("payload").put("kind", "install_apk"); reject(action, "invalid_kind");
        JSONObject approval = valid(2); approval.getJSONObject("payload").put("approval_class", "auto"); reject(approval, "invalid_approval_class");
        JSONObject future = valid(3); reject(future, "unsupported_version");
    }

    @Test public void rejectsUnknownCredentialExecutableAndUnsafeValuesRecursively() throws Exception {
        JSONObject extra = valid(2).put("surprise", true); reject(extra, "invalid_shape");
        JSONObject token = valid(2); token.getJSONObject("payload").getJSONObject("params").put("oauth_token", "plain"); reject(token, "credential_payload");
        JSONObject url = valid(2); url.getJSONObject("payload").getJSONObject("params").put("url", "https://x.test/?code=oauth-secret-123456"); reject(url, "credential_payload");
        JSONObject script = valid(2); script.getJSONObject("payload").getJSONObject("params").put("java-script", "alert(1)"); reject(script, "executable_payload");
        JSONObject unsafe = valid(2); unsafe.getJSONObject("payload").getJSONObject("params").put("count", 9_007_199_254_740_992L); reject(unsafe, "unsafe_number");
    }

    @Test public void adapterExposesNoExecutionDecision() throws Exception {
        AggieProposalAdapter.Proposal proposal = AggieProposalAdapter.parse(valid(2));
        assertEquals("proposal_1", proposal.payload.getString("proposal_id"));
        assertEquals("sess_1", proposal.payload.getString("session_id"));
        assertEquals("gateway", proposal.payload.getString("proposed_by"));
    }

    private static JSONObject valid(int version) throws Exception {
        return new JSONObject("{\"version\":" + version + ",\"type\":\"action.proposed\",\"message_id\":\"proposal_message_1\",\"session_id\":\"sess_1\",\"surface\":{\"id\":\"moa-android\",\"kind\":\"android\",\"mode\":\"text\",\"device_id\":\"pixel_1\"},\"timestamp\":\"2026-07-10T12:00:00.000Z\",\"payload\":{\"proposal_id\":\"proposal_1\",\"kind\":\"open_app\",\"approval_class\":\"confirm\",\"expires_at\":\"2026-07-10T12:01:00.000Z\",\"preconditions\":{\"foreground_package\":\"ai.moa.assistant\"},\"params\":{\"package_name\":\"com.example.app\"}}}");
    }

    private static void reject(JSONObject envelope, String code) {
        try { AggieProposalAdapter.parse(envelope); fail("expected " + code); }
        catch (AggieProposalAdapter.Rejected error) { assertEquals(code, error.code); }
    }
}

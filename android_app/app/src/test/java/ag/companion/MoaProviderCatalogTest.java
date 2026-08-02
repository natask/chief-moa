package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaProviderCatalogTest {
    @Test
    public void parsesGatewayChoicesAndExplainsUnavailableProvider() throws Exception {
        JSONObject payload = new JSONObject()
                .put("credentials_owner", "gateway")
                .put("active_selection", new JSONObject().put("choice_id", "ready"))
                .put("choices", new JSONArray()
                        .put(choice("ready", "OpenAI reasoning", true, true, "configured", "gpt-ready"))
                        .put(choice("blocked", "Claude reasoning", false, false, "unavailable", "claude-ready")
                                .put("issues", new JSONArray().put("Reasoner adapter is not implemented"))))
                .put("provider_api_key", "must-not-be-consumed");
        MoaProviderCatalog catalog = MoaProviderCatalog.parse(payload,
                new JSONObject().put("profile_version", "profile-7"));

        assertEquals("profile-7", catalog.profileVersion);
        assertEquals(2, catalog.choices.size());
        assertTrue(catalog.choices.get(0).active);
        assertTrue(catalog.choices.get(0).configured);
        assertEquals("gpt-ready", catalog.choices.get(0).modelId);
        assertFalse(catalog.choices.get(1).configured);
        assertTrue(catalog.choices.get(1).statusText().contains("Reasoner adapter is not implemented"));
    }

    @Test
    public void prefersDefaultModelAndFallsBackToCurrentVersion() throws Exception {
        JSONObject item = choice("voice", "Voice", true, true, "configured", "first")
                .put("models", new JSONArray()
                        .put(new JSONObject().put("id", "first"))
                        .put(new JSONObject().put("id", "preferred").put("default", true)));
        MoaProviderCatalog catalog = MoaProviderCatalog.parse(
                new JSONObject().put("choices", new JSONArray().put(item)),
                new JSONObject().put("current_version", "profile-8"));

        assertEquals("preferred", catalog.choices.get(0).modelId);
        assertEquals("profile-8", catalog.profileVersion);
        assertTrue(MoaProviderCatalog.confirmsNewVersion("profile-7",
                new JSONObject().put("profile_version", "profile-8")));
        assertFalse(MoaProviderCatalog.confirmsNewVersion("profile-8",
                new JSONObject().put("profile_version", "profile-8")));
        assertFalse(MoaProviderCatalog.confirmsNewVersion("profile-8", new JSONObject()));
    }

    private static JSONObject choice(String id, String label, boolean available,
            boolean configured, String status, String model) throws Exception {
        return new JSONObject()
                .put("id", id)
                .put("label", label)
                .put("available", available)
                .put("configured", configured)
                .put("status", status)
                .put("models", new JSONArray().put(
                        new JSONObject().put("id", model).put("default", true)));
    }
}

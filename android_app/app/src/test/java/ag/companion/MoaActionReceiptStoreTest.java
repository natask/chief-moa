package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public final class MoaActionReceiptStoreTest {
    @Test
    public void settingsActionProducesNavigationReceipt() {
        JSONObject receipt = MoaActionReceiptStore.createReceipt(
                "app.settings.open",
                "navigation",
                "implicit_user_command",
                "ag.companion",
                true,
                "Opened Ag settings.",
                1234L,
                "previous"
        );

        assertEquals("app.settings.open", receipt.optString("tool"));
        assertEquals("navigation", receipt.optString("risk"));
        assertEquals("implicit_user_command", receipt.optString("approval"));
        assertEquals("ag.companion", receipt.optString("target"));
        assertEquals(true, receipt.optBoolean("success"));
        assertEquals("Opened Ag settings.", receipt.optString("result"));
        assertEquals(1234L, receipt.optLong("timestamp_ms"));
        assertEquals("previous", receipt.optString("previous_hash"));
        assertFalse(receipt.optString("hash").isEmpty());
    }

    @Test
    public void mediaReceiptCarriesExplicitTruthfulOutcomeInsideHash() {
        JSONObject receipt = MoaActionReceiptStore.createReceipt(
                "media.open", "navigation", "implicit_user_command", "youtube",
                false, "Search opened; no result was selected.", 1234L, "previous",
                "search_opened");

        assertEquals("search_opened", receipt.optString("outcome"));
        assertFalse(receipt.optBoolean("success"));
        assertFalse(receipt.optString("hash").isEmpty());
    }
}

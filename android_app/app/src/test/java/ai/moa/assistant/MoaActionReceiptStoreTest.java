package ai.moa.assistant;

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
                "ai.moa.assistant",
                true,
                "Opened AG settings.",
                1234L,
                "previous"
        );

        assertEquals("app.settings.open", receipt.optString("tool"));
        assertEquals("navigation", receipt.optString("risk"));
        assertEquals("implicit_user_command", receipt.optString("approval"));
        assertEquals("ai.moa.assistant", receipt.optString("target"));
        assertEquals(true, receipt.optBoolean("success"));
        assertEquals("Opened AG settings.", receipt.optString("result"));
        assertEquals(1234L, receipt.optLong("timestamp_ms"));
        assertEquals("previous", receipt.optString("previous_hash"));
        assertFalse(receipt.optString("hash").isEmpty());
    }
}

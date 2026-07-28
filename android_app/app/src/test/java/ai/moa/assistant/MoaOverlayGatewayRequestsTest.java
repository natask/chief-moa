package ai.moa.assistant;

import static org.junit.Assert.assertEquals;

import org.json.JSONArray;
import org.junit.Test;

import java.util.Arrays;

public final class MoaOverlayGatewayRequestsTest {
    @Test
    public void historyKeepsTheBoundedNewestTurnsInWireOrder() throws Exception {
        JSONArray history = MoaOverlayGatewayRequests.history(Arrays.asList(
                new ChatMessage(false, "old"),
                new ChatMessage(true, "answer"),
                new ChatMessage(false, "follow up")), 2);
        assertEquals(2, history.length());
        assertEquals("assistant", history.getJSONObject(0).getString("role"));
        assertEquals("answer", history.getJSONObject(0).getString("content"));
        assertEquals("user", history.getJSONObject(1).getString("role"));
        assertEquals("follow up", history.getJSONObject(1).getString("content"));
    }
}

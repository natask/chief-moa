package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaSessionHistoryTest {
    @Test
    public void canonicalMessagesBecomeBoundedMixedSourceTurnPairs() throws Exception {
        String longUserText = "  " + "idea ".repeat(2_278) + "done  ";
        JSONObject payload = new JSONObject()
                .put("session_id", "shared-1")
                .put("messages", new JSONArray()
                        .put(canonical("msg_user_1", "turn_1", "user", longUserText)
                                .put("source_surface", "android")
                                .put("source_kind", "voice")
                                .put("classification", "chat")
                                .put("completion_state", "completed"))
                        .put(canonical("msg_assistant_1", "turn_1", "assistant", "I saved that idea.")
                                .put("text_truncated", true))
                        // Canonical message identity prevents duplicate rendering.
                        .put(canonical("msg_user_1", "turn_1", "user", "duplicate"))
                        .put(new JSONObject()
                                .put("id", "chat:shared-1:turn_2")
                                .put("type", "chat_turn")
                                .put("source", "agee-extension")
                                .put("session_id", "shared-1")
                                .put("branch_id", "browser-work")
                                .put("turn_id", "turn_2")
                                .put("classification", "agent_run")
                                .put("text", "Build it from the browser.")
                                .put("assistant_text", "Started run_2.")));

        MoaSessionHistory history = MoaSessionHistory.from(payload, "ignored");

        assertEquals("shared-1", history.sessionId);
        assertEquals(2, history.turns.size());
        MoaSessionHistory.Turn android = history.turns.get(0);
        assertEquals(longUserText, android.userText);
        assertEquals("I saved that idea.", android.assistantText);
        assertEquals("msg_user_1", android.userMessageId);
        assertEquals("msg_assistant_1", android.assistantMessageId);
        assertEquals("android  ·  voice  ·  chat  ·  branch default  ·  completed  ·  text truncated by gateway", android.metadataLine());

        MoaSessionHistory.Turn browser = history.turns.get(1);
        assertEquals("browser", browser.sourceSurface);
        assertEquals("text", browser.sourceKind);
        assertEquals("browser-work", browser.branchId);
        assertEquals("Build it from the browser.", browser.userText);
        assertEquals("Started run_2.", browser.assistantText);
        assertTrue(browser.metadataLine().contains("agent_run"));
    }

    @Test
    public void overlongDisplayTextIsCappedWithoutInventingAssistantText() throws Exception {
        String tooLong = "x".repeat(MoaSessionHistory.MAX_TEXT_CHARS + 100);
        JSONObject payload = new JSONObject().put("messages", new JSONArray()
                .put(canonical("msg_1", "turn_1", "user", tooLong)));

        MoaSessionHistory.Turn turn = MoaSessionHistory.from(payload, "shared-2").turns.get(0);

        assertTrue(turn.userText.endsWith("[display capped]"));
        assertTrue(turn.userText.length() < tooLong.length());
        assertFalse(turn.userText.isEmpty());
        assertEquals("", turn.assistantText);
    }

    @Test
    public void gatewayMaximumTextRemainsExact() throws Exception {
        String maximum = "x".repeat(32_768);
        JSONObject payload = new JSONObject().put("messages", new JSONArray()
                .put(canonical("msg_max", "turn_max", "user", maximum)));

        MoaSessionHistory.Turn turn = MoaSessionHistory.from(payload, "shared-maximum").turns.get(0);

        assertEquals(maximum, turn.userText);
        assertFalse(turn.userText.endsWith("[display capped]"));
    }

    private static JSONObject canonical(String messageId, String turnId, String speaker, String text) throws Exception {
        return new JSONObject()
                .put("message_id", messageId)
                .put("session_id", "shared-1")
                .put("branch_id", "default")
                .put("turn_id", turnId)
                .put("speaker", speaker)
                .put("text", text);
    }
}

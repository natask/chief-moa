package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaTtsRecoveryPlanTest {
    @Test
    public void partialUsesSuffixOnlyWhenBoundaryAndReplyLengthMatch() throws Exception {
        MoaTtsRecoveryPlan plan = MoaTtsRecoveryPlan.fromTurnDone(new JSONObject()
                .put("tts_delivery", "partial")
                .put("tts_spoken_text_end", 6)
                .put("tts_reply_text_chars", 11), "hello world");

        assertTrue(plan.shouldRetry());
        assertEquals(6, plan.fromTextChar);
        assertEquals("world", plan.text);
    }

    @Test
    public void partialFallsBackToWholeReplyForMissingOrDriftedBoundary() throws Exception {
        JSONObject drifted = new JSONObject()
                .put("tts_delivery", "partial")
                .put("tts_spoken_text_end", 6)
                .put("tts_reply_text_chars", 12);
        MoaTtsRecoveryPlan plan = MoaTtsRecoveryPlan.fromTurnDone(drifted, "hello world");

        assertEquals(0, plan.fromTextChar);
        assertEquals("hello world", plan.text);
    }

    @Test
    public void failedAlwaysRetriesWholeReplyEvenWithClaimedBoundary() throws Exception {
        MoaTtsRecoveryPlan plan = MoaTtsRecoveryPlan.fromTurnDone(new JSONObject()
                .put("tts_delivery", "failed")
                .put("tts_spoken_text_end", 5)
                .put("tts_reply_text_chars", 11), "hello world");

        assertEquals(0, plan.fromTextChar);
        assertEquals("hello world", plan.text);
    }

    @Test
    public void legacyAndNonFailureOutcomesDoNotInventRecovery() throws Exception {
        assertFalse(MoaTtsRecoveryPlan.fromTurnDone(
                new JSONObject().put("status", "completed"), "reply").shouldRetry());
        assertFalse(MoaTtsRecoveryPlan.fromTurnDone(
                new JSONObject().put("tts_delivery", "complete"), "reply").shouldRetry());
        assertFalse(MoaTtsRecoveryPlan.fromTurnDone(
                new JSONObject().put("tts_delivery", "not_requested"), "reply").shouldRetry());
    }

    @Test
    public void hostileBoundaryTypesFailClosedAndErrorIsBounded() throws Exception {
        MoaTtsRecoveryPlan plan = MoaTtsRecoveryPlan.fromTurnDone(new JSONObject()
                .put("tts_delivery", "partial")
                .put("tts_spoken_text_end", "6")
                .put("tts_reply_text_chars", 11)
                .put("tts_error", "x".repeat(300)), "hello world");

        assertEquals(0, plan.fromTextChar);
        assertEquals(240, plan.error.length());
    }
}

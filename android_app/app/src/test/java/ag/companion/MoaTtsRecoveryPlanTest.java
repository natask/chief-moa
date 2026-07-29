package ag.companion;

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
    public void partialFailsClosedForMissingOrDriftedBoundary() throws Exception {
        JSONObject drifted = new JSONObject()
                .put("tts_delivery", "partial")
                .put("tts_spoken_text_end", 6)
                .put("tts_reply_text_chars", 12);
        MoaTtsRecoveryPlan plan = MoaTtsRecoveryPlan.fromTurnDone(drifted, "hello world");

        assertFalse(plan.shouldRetry());
        assertEquals(-1, plan.fromTextChar);
        assertEquals("", plan.text);
        assertFalse(MoaTtsRecoveryPlan.fromTurnDone(new JSONObject()
                .put("tts_delivery", "partial"), "hello world").shouldRetry());
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

        assertFalse(plan.shouldRetry());
        assertEquals(-1, plan.fromTextChar);
        assertEquals(240, plan.error.length());
    }

    @Test
    public void partialRejectsFractionalOverflowAndUnboundedProtocolNumbers() throws Exception {
        for (Number hostile : new Number[] {
                6.5D, -1D, Double.NaN, Double.POSITIVE_INFINITY,
                ((long) Integer.MAX_VALUE) + 1L
        }) {
            for (String key : new String[] {"tts_spoken_text_end", "tts_reply_text_chars"}) {
                JSONObject event = numericEvent(key, hostile)
                        .put("tts_delivery", "partial")
                        .put("tts_spoken_text_end", 6)
                        .put("tts_reply_text_chars", 11);
                assertFalse(MoaTtsRecoveryPlan.fromTurnDone(event, "hello world").shouldRetry());
                assertEquals(-1, MoaTtsRecoveryPlan.exactNonNegativeInt(event, key));
            }
        }
        assertFalse(MoaTtsRecoveryPlan.fromTurnDone(new JSONObject()
                .put("tts_delivery", "partial")
                .put("tts_spoken_text_end", 12)
                .put("tts_reply_text_chars", 11), "hello world").shouldRetry());
        assertFalse(MoaTtsRecoveryPlan.fromTurnDone(new JSONObject()
                .put("tts_delivery", "partial")
                .put("tts_spoken_text_end", 11)
                .put("tts_reply_text_chars", 11), "hello world").shouldRetry());
    }

    private static JSONObject numericEvent(String key, Number value) {
        return new JSONObject() {
            @Override
            public boolean has(String candidate) {
                return key.equals(candidate) || super.has(candidate);
            }

            @Override
            public Object opt(String candidate) {
                return key.equals(candidate) ? value : super.opt(candidate);
            }
        };
    }
}

package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class MoaReminderNotificationPolicyTest {
    @Test
    public void acceptsExactDueReminderAndDeliveryBinding() throws Exception {
        JSONObject input = input();
        JSONObject reminder = reminder();

        MoaReminderNotificationPolicy.Decision decision =
                MoaReminderNotificationPolicy.evaluate("treq_1", "phone_1", input, reminder);

        assertTrue(decision.allowed);
        assertEquals("Take a break", decision.message);
    }

    @Test
    public void rejectsCanceledStaleOrMutatedReminder() throws Exception {
        JSONObject canceled = reminder().put("status", "canceled");
        assertFalse(MoaReminderNotificationPolicy.evaluate(
                "treq_1", "phone_1", input(), canceled).allowed);

        JSONObject retargeted = reminder();
        retargeted.getJSONObject("delivery").put("target_device_id", "other_phone");
        assertEquals("reminder_delivery_binding_mismatch",
                MoaReminderNotificationPolicy.evaluate(
                        "treq_1", "phone_1", input(), retargeted).reason);

        JSONObject mutated = reminder().put("message", "Changed remotely");
        assertEquals("reminder_content_mismatch",
                MoaReminderNotificationPolicy.evaluate(
                        "treq_1", "phone_1", input(), mutated).reason);
    }

    @Test
    public void rejectsMissingCanonicalStateAndRequestIdentity() throws Exception {
        assertEquals("missing_reminder_binding",
                MoaReminderNotificationPolicy.evaluate("", "phone_1", input(), reminder()).reason);
        assertEquals("reminder_identity_mismatch",
                MoaReminderNotificationPolicy.evaluate("treq_1", "phone_1", input(), null).reason);
    }

    private static JSONObject input() throws Exception {
        return new JSONObject()
                .put("reminder_id", "rem_0123456789abcdef0123456789abcdef")
                .put("message", "Take a break")
                .put("due_at", "2026-08-02T20:00:00.000Z");
    }

    private static JSONObject reminder() throws Exception {
        return new JSONObject()
                .put("id", "rem_0123456789abcdef0123456789abcdef")
                .put("message", "Take a break")
                .put("due_at", "2026-08-02T20:00:00.000Z")
                .put("status", "due")
                .put("delivery", new JSONObject()
                        .put("status", "queued")
                        .put("tool_request_id", "treq_1")
                        .put("target_device_id", "phone_1"));
    }
}

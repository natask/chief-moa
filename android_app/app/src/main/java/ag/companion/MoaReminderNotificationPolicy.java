package ag.companion;

import org.json.JSONObject;

/** Fail-closed binding between a claimed tool request and canonical reminder state. */
final class MoaReminderNotificationPolicy {
    private MoaReminderNotificationPolicy() {
    }

    static Decision evaluate(String requestId, String deviceId, JSONObject input,
            JSONObject reminder) {
        String reminderId = safe(input == null ? "" : input.optString("reminder_id", ""));
        if (safe(requestId).isEmpty() || safe(deviceId).isEmpty() || reminderId.isEmpty()) {
            return Decision.denied("missing_reminder_binding");
        }
        if (reminder == null || !reminderId.equals(safe(reminder.optString("id", "")))) {
            return Decision.denied("reminder_identity_mismatch");
        }
        if (!"due".equals(safe(reminder.optString("status", "")))) {
            return Decision.denied("reminder_is_not_due");
        }
        JSONObject delivery = reminder.optJSONObject("delivery");
        if (delivery == null || !"queued".equals(safe(delivery.optString("status", "")))
                || !requestId.equals(safe(delivery.optString("tool_request_id", "")))
                || !deviceId.equals(safe(delivery.optString("target_device_id", "")))) {
            return Decision.denied("reminder_delivery_binding_mismatch");
        }
        String message = safe(reminder.optString("message", ""));
        String dueAt = safe(reminder.optString("due_at", ""));
        if (message.isEmpty() || dueAt.isEmpty()
                || !message.equals(safe(input.optString("message", "")))
                || !dueAt.equals(safe(input.optString("due_at", "")))) {
            return Decision.denied("reminder_content_mismatch");
        }
        return Decision.allowed(reminderId, message, dueAt);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    static final class Decision {
        final boolean allowed;
        final String reason;
        final String reminderId;
        final String message;
        final String dueAt;

        private Decision(boolean allowed, String reason, String reminderId, String message,
                String dueAt) {
            this.allowed = allowed;
            this.reason = reason;
            this.reminderId = reminderId;
            this.message = message;
            this.dueAt = dueAt;
        }

        static Decision allowed(String reminderId, String message, String dueAt) {
            return new Decision(true, "allowed", reminderId, message, dueAt);
        }

        static Decision denied(String reason) {
            return new Decision(false, reason, "", "", "");
        }
    }
}

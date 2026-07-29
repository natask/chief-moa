package ai.moa.assistant;

import org.json.JSONObject;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/** One durable explicit authorization payload; timestamp and retry key never drift apart. */
final class MoaCreateFixAuthorization {
    private static final Duration CLIENT_VALIDITY = Duration.ofMinutes(9);
    private static final String ID = "[A-Za-z0-9._:-]{1,200}";

    final String feedbackId;
    final String idempotencyKey;
    final String authorizedAt;

    MoaCreateFixAuthorization(String feedbackId, String idempotencyKey, String authorizedAt) {
        this.feedbackId = requireId(feedbackId, "feedback_id");
        this.idempotencyKey = requireId(idempotencyKey, "idempotency_key");
        try {
            this.authorizedAt = Instant.parse(authorizedAt).toString();
        } catch (Exception error) {
            throw new IllegalArgumentException("authorization timestamp is invalid");
        }
    }

    /** Called only from a fresh explicit Create fix gesture. */
    static MoaCreateFixAuthorization authorizeExplicitly(
            String feedbackId, MoaCreateFixAuthorization stored, Instant now) {
        if (now == null) throw new IllegalArgumentException("authorization time is required");
        if (stored != null && stored.feedbackId.equals(feedbackId) && stored.isCurrentAt(now)) {
            return stored;
        }
        return new MoaCreateFixAuthorization(feedbackId,
                "create-fix-" + UUID.randomUUID(), now.toString());
    }

    boolean isCurrentAt(Instant now) {
        if (now == null) return false;
        Instant start = Instant.parse(authorizedAt);
        return !now.isBefore(start.minusSeconds(60L))
                && !now.isAfter(start.plus(CLIENT_VALIDITY));
    }

    JSONObject toJson() throws Exception {
        return new JSONObject().put("feedback_id", feedbackId)
                .put("idempotency_key", idempotencyKey).put("authorized_at", authorizedAt);
    }

    static MoaCreateFixAuthorization fromJson(JSONObject value) {
        if (value == null) throw new IllegalArgumentException("authorization is missing");
        return new MoaCreateFixAuthorization(value.optString("feedback_id", ""),
                value.optString("idempotency_key", ""), value.optString("authorized_at", ""));
    }

    private static String requireId(String value, String name) {
        String id = value == null ? "" : value;
        if (!id.matches(ID)) throw new IllegalArgumentException(name + " is invalid");
        return id;
    }
}

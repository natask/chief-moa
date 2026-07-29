package ai.moa.assistant;

import org.junit.Test;

import java.time.Instant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertSame;

public final class MoaCreateFixAuthorizationTest {
    @Test
    public void lostResponseRetryReusesExactTimestampAndIdempotencyKey() {
        Instant firstPress = Instant.parse("2026-07-28T12:00:00Z");
        MoaCreateFixAuthorization first = MoaCreateFixAuthorization.authorizeExplicitly(
                "feedback-1", null, firstPress);

        MoaCreateFixAuthorization retry = MoaCreateFixAuthorization.authorizeExplicitly(
                "feedback-1", first, firstPress.plusSeconds(120L));

        assertSame(first, retry);
        assertEquals(first.authorizedAt, retry.authorizedAt);
        assertEquals(first.idempotencyKey, retry.idempotencyKey);
    }

    @Test
    public void expiredAuthorizationRequiresFreshExplicitPressIdentity() {
        Instant firstPress = Instant.parse("2026-07-28T12:00:00Z");
        MoaCreateFixAuthorization first = MoaCreateFixAuthorization.authorizeExplicitly(
                "feedback-1", null, firstPress);

        MoaCreateFixAuthorization renewed = MoaCreateFixAuthorization.authorizeExplicitly(
                "feedback-1", first, firstPress.plusSeconds(541L));

        assertNotEquals(first.authorizedAt, renewed.authorizedAt);
        assertNotEquals(first.idempotencyKey, renewed.idempotencyKey);
    }

    @Test
    public void anotherFeedbackNeverReusesAuthorization() {
        Instant now = Instant.parse("2026-07-28T12:00:00Z");
        MoaCreateFixAuthorization first = MoaCreateFixAuthorization.authorizeExplicitly(
                "feedback-1", null, now);
        MoaCreateFixAuthorization second = MoaCreateFixAuthorization.authorizeExplicitly(
                "feedback-2", first, now.plusSeconds(1L));
        assertNotEquals(first.idempotencyKey, second.idempotencyKey);
    }
}

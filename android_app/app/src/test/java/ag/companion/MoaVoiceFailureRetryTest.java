package ag.companion;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.atomic.AtomicInteger;

import org.junit.Test;

public final class MoaVoiceFailureRetryTest {
    @Test
    public void retryIsAvailableExactlyOnceForFailureGeneration() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        retry.arm(7);

        assertTrue(retry.isAvailable(7));
        assertTrue(retry.consume(7));
        assertFalse(retry.consume(7));
        assertFalse(retry.isAvailable(7));
    }

    @Test
    public void staleGenerationCannotStartCapture() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        retry.arm(7);

        assertFalse(retry.consume(8));
        assertFalse(retry.isAvailable(8));
    }

    @Test
    public void intentionalCloseInvalidatesFailureAction() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        retry.arm(7);

        retry.invalidate();

        assertFalse(retry.consume(7));
    }

    @Test
    public void laterFailureReplacesEarlierAuthority() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        retry.arm(7);
        retry.arm(9);

        assertFalse(retry.consume(7));
        assertTrue(retry.consume(9));
    }

    @Test
    public void actionSeamStartsExactlyOneFreshCapture() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        AtomicInteger freshControllers = new AtomicInteger();
        retry.arm(12);

        assertTrue(retry.consumeAndRun(12, freshControllers::incrementAndGet));
        assertFalse(retry.consumeAndRun(12, freshControllers::incrementAndGet));
        assertEquals(1, freshControllers.get());
    }

    @Test
    public void intentionalTeardownInvalidatesActionAndStalesControllerCallbacks() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        retry.arm(20);

        int currentGeneration = retry.invalidateForIntentionalTeardown(20, true);

        assertEquals(21, currentGeneration);
        assertFalse(retry.consume(20));
        assertFalse(retry.consume(currentGeneration));
        assertTrue(20 != currentGeneration);
    }

    @Test
    public void teardownWithoutControllerDoesNotInventGeneration() {
        MoaVoiceFailureRetry retry = new MoaVoiceFailureRetry();
        retry.arm(20);

        assertEquals(20, retry.invalidateForIntentionalTeardown(20, false));
        assertFalse(retry.isAvailable(20));
    }
}

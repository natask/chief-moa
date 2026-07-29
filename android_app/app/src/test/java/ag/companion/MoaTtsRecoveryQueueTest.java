package ag.companion;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class MoaTtsRecoveryQueueTest {
    @Test
    public void gatewayAudioDoneThenTurnDoneQueuesUntilPhysicalDrain() {
        MoaTtsRecoveryQueue queue = new MoaTtsRecoveryQueue();

        // assistant_audio_done only starts controller-side draining. Gateway
        // turn_done may follow immediately while prefix PCM remains buffered.
        assertNull(queue.onTerminal("turn-1", "retry-1", 12, true));
        assertTrue(queue.hasPending());

        MoaTtsRecoveryQueue.Request ready = queue.onPlaybackDrained("turn-1");
        assertEquals("retry-1", ready.retryId);
        assertEquals(12, ready.fromTextChar);
    }

    @Test
    public void alreadyDrainedPrefixAllowsTerminalRecoveryImmediately() {
        MoaTtsRecoveryQueue queue = new MoaTtsRecoveryQueue();

        assertNull(queue.onPlaybackDrained("turn-1"));
        MoaTtsRecoveryQueue.Request ready = queue.onTerminal("turn-1", "retry-1", 0, true);

        assertEquals("turn-1", ready.turnId);
        assertEquals(0, ready.fromTextChar);
    }

    @Test
    public void unrelatedDrainCannotReleasePendingRecovery() {
        MoaTtsRecoveryQueue queue = new MoaTtsRecoveryQueue();
        assertNull(queue.onTerminal("turn-1", "retry-1", 5, true));
        assertNull(queue.onPlaybackDrained("turn-other"));
        assertTrue(queue.hasPending());
    }

    @Test
    public void failedSynthesisWithZeroPrefixRetriesAtTerminalWithoutAudioDone() {
        MoaTtsRecoveryQueue queue = new MoaTtsRecoveryQueue();

        MoaTtsRecoveryQueue.Request ready =
                queue.onTerminal("turn-failed", "retry-full", 0, false);

        assertEquals("turn-failed", ready.turnId);
        assertEquals("retry-full", ready.retryId);
        assertEquals(0, ready.fromTextChar);
    }
}

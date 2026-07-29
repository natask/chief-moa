package ag.companion;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

public final class MoaStreamingVoiceContinuationGateTest {
    @Test
    public void destroyedOrSupersededBranchResolutionHasNoOpenEffect() {
        AtomicInteger opens = new AtomicInteger();

        assertFalse(MoaStreamingVoiceContinuationGate.runResolvedBranch(
                false,
                7L,
                7L,
                opens::incrementAndGet
        ));
        assertFalse(MoaStreamingVoiceContinuationGate.runResolvedBranch(
                true,
                7L,
                8L,
                opens::incrementAndGet
        ));
        assertEquals(0, opens.get());

        assertTrue(MoaStreamingVoiceContinuationGate.runResolvedBranch(
                true,
                8L,
                8L,
                opens::incrementAndGet
        ));
        assertEquals(1, opens.get());
    }

    @Test
    public void queuedReleaseCommitsOnlyItsExactControllerGenerationAndToken() {
        Object admittedController = new Object();
        Object replacementController = new Object();
        AtomicInteger commits = new AtomicInteger();

        assertFalse(MoaStreamingVoiceContinuationGate.runQueuedCommit(
                false, 4, 4, admittedController, admittedController, 10L, 10L,
                commits::incrementAndGet
        ));
        assertFalse(MoaStreamingVoiceContinuationGate.runQueuedCommit(
                true, 4, 5, admittedController, admittedController, 10L, 10L,
                commits::incrementAndGet
        ));
        assertFalse(MoaStreamingVoiceContinuationGate.runQueuedCommit(
                true, 4, 4, admittedController, replacementController, 10L, 10L,
                commits::incrementAndGet
        ));
        assertFalse(MoaStreamingVoiceContinuationGate.runQueuedCommit(
                true, 4, 4, admittedController, admittedController, 10L, 11L,
                commits::incrementAndGet
        ));
        assertEquals(0, commits.get());

        assertTrue(MoaStreamingVoiceContinuationGate.runQueuedCommit(
                true, 4, 4, admittedController, admittedController, 10L, 10L,
                commits::incrementAndGet
        ));
        assertEquals(1, commits.get());
    }
}

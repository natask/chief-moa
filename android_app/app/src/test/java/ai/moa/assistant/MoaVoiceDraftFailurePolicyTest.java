package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceDraftFailurePolicyTest {
    @Test
    public void everyTerminalDraftFailureStopsCaptureWithoutSendOrCanonicalCancel() {
        for (MoaVoiceDraftFailurePolicy.Cause cause : MoaVoiceDraftFailurePolicy.Cause.values()) {
            MoaVoiceDraftFailurePolicy.Plan plan = MoaVoiceDraftFailurePolicy.terminal(cause);
            assertEquals(cause, plan.cause);
            assertTrue(plan.stopCapture);
            assertTrue(plan.destroySocket);
            assertTrue(plan.retryableError);
            assertFalse(plan.sendDraftCommit);
            assertFalse(plan.sendCanonicalCancelTurn);
            assertTrue(plan.preserveValidatedParkedPointer);
            assertFalse(plan.preserveUnvalidatedPointer);
        }
    }

    @Test
    public void setupControlGatewayNormalCloseAndTimeoutsShareTheNoExecuteTeardown() {
        MoaVoiceDraftFailurePolicy.Cause[] required = {
                MoaVoiceDraftFailurePolicy.Cause.SESSION_START_ENQUEUE,
                MoaVoiceDraftFailurePolicy.Cause.CONTROL_ENQUEUE,
                MoaVoiceDraftFailurePolicy.Cause.GATEWAY_ERROR,
                MoaVoiceDraftFailurePolicy.Cause.SOCKET_CLOSED,
                MoaVoiceDraftFailurePolicy.Cause.READY_TIMEOUT,
                MoaVoiceDraftFailurePolicy.Cause.CONTROL_ACK_TIMEOUT
        };
        for (MoaVoiceDraftFailurePolicy.Cause cause : required) {
            MoaVoiceDraftFailurePolicy.Plan plan = MoaVoiceDraftFailurePolicy.terminal(cause);
            assertTrue(plan.stopCapture);
            assertTrue(plan.destroySocket);
            assertFalse(plan.sendDraftCommit);
            assertFalse(plan.sendCanonicalCancelTurn);
        }
    }
}

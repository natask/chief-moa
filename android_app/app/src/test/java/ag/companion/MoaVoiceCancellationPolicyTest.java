package ag.companion;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaVoiceCancellationPolicyTest {
    @Test
    public void preSendDraftNeverSelectsCanonicalCancelTurn() {
        assertEquals(
                MoaVoiceCancellationPolicy.Effect.DRAFT_DISCARD_OR_AUTO_PARK,
                MoaVoiceCancellationPolicy.forSession(true)
        );
        assertEquals(
                MoaVoiceCancellationPolicy.Effect.CANONICAL_CANCEL_TURN,
                MoaVoiceCancellationPolicy.forSession(false)
        );
    }
}

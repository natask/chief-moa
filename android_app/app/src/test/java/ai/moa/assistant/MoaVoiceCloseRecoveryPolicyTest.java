package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceCloseRecoveryPolicyTest {
    @Test public void remoteCloseAfterCommittedTranscriptOffersRetry() {
        assertTrue(MoaVoiceCloseRecoveryPolicy.shouldOfferTextRetry(
                MoaVoiceSessionTermination.remoteClose(1006, "abnormal closure"),
                true,
                "keep these recognized words"));
    }

    @Test public void localCancelNeverOffersRetry() {
        assertFalse(MoaVoiceCloseRecoveryPolicy.shouldOfferTextRetry(
                MoaVoiceSessionTermination.localCancel(),
                true,
                "do not resend me"));
    }

    @Test public void retryAdmissionRequiresPreservedTextAndAvailableState() {
        assertFalse(MoaVoiceCloseRecoveryPolicy.canConsumeTextRetry(false, "recognized"));
        assertFalse(MoaVoiceCloseRecoveryPolicy.canConsumeTextRetry(true, "  "));
        assertTrue(MoaVoiceCloseRecoveryPolicy.canConsumeTextRetry(true, "recognized"));
    }
}

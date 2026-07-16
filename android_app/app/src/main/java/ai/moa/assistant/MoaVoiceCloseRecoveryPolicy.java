package ai.moa.assistant;

final class MoaVoiceCloseRecoveryPolicy {
    private MoaVoiceCloseRecoveryPolicy() {
    }

    static boolean shouldOfferTextRetry(
            MoaVoiceSessionTermination termination,
            boolean committed,
            String recognizedText
    ) {
        return termination != null
                && termination.kind == MoaVoiceSessionTermination.Kind.REMOTE_CLOSE
                && committed
                && recognizedText != null
                && !recognizedText.trim().isEmpty();
    }

    static boolean canConsumeTextRetry(boolean retryAvailable, String recognizedText) {
        return retryAvailable
                && recognizedText != null
                && !recognizedText.trim().isEmpty();
    }
}

package ag.companion;

/** Pure teardown policy preventing pre-SEND drafts from becoming canonical cancellations. */
final class MoaVoiceCancellationPolicy {
    enum Effect {
        CANONICAL_CANCEL_TURN,
        DRAFT_DISCARD_OR_AUTO_PARK
    }

    private MoaVoiceCancellationPolicy() {
    }

    static Effect forSession(boolean localDraftMode) {
        return localDraftMode
                ? Effect.DRAFT_DISCARD_OR_AUTO_PARK
                : Effect.CANONICAL_CANCEL_TURN;
    }
}

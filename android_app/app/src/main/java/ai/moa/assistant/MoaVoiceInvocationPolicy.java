package ai.moa.assistant;

final class MoaVoiceInvocationPolicy {
    enum Action {
        START_LATCHED_CAPTURE,
        COMMIT_LATCHED_CAPTURE,
        IGNORE_WHILE_PUSH_TO_TALK
    }

    private MoaVoiceInvocationPolicy() {
    }

    static Action decide(boolean latchedCaptureActive, boolean pushToTalkActive) {
        if (pushToTalkActive) {
            return Action.IGNORE_WHILE_PUSH_TO_TALK;
        }
        return latchedCaptureActive
                ? Action.COMMIT_LATCHED_CAPTURE
                : Action.START_LATCHED_CAPTURE;
    }
}

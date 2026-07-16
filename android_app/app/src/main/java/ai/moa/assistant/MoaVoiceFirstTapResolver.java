package ai.moa.assistant;

import java.util.Collections;
import java.util.List;

final class MoaVoiceFirstTapResolver {
    enum CaptureOrigin {
        NONE,
        CURRENT_THREAD
    }

    enum Action {
        START_OR_CONTINUE,
        STOP_AND_SEND,
        HARD_INTERRUPT
    }

    private int tapCount;

    boolean hasOpenChord() {
        return tapCount > 0;
    }

    void tapUp() {
        tapCount++;
    }

    List<Action> resolve(CaptureOrigin captureOrigin) {
        int resolvedTapCount = tapCount;
        reset();
        CaptureOrigin origin = captureOrigin == null ? CaptureOrigin.NONE : captureOrigin;
        if (resolvedTapCount == 1) {
            return Collections.singletonList(origin == CaptureOrigin.CURRENT_THREAD
                    ? Action.STOP_AND_SEND
                    : Action.START_OR_CONTINUE);
        }
        if (resolvedTapCount == 2) {
            return origin == CaptureOrigin.NONE
                    ? Collections.singletonList(Action.START_OR_CONTINUE)
                    : Collections.emptyList();
        }
        if (resolvedTapCount == 3) {
            return Collections.singletonList(Action.HARD_INTERRUPT);
        }
        return Collections.emptyList();
    }

    void reset() {
        tapCount = 0;
    }
}

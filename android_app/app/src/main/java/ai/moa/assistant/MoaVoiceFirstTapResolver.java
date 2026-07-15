package ai.moa.assistant;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class MoaVoiceFirstTapResolver {
    enum CaptureOrigin {
        NONE,
        CURRENT_THREAD,
        FRESH_THREAD
    }

    enum Action {
        START_OR_INTERRUPT,
        STOP_AND_SEND,
        CANCEL_CAPTURE,
        START_FRESH,
        OPEN_CHAT
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
            if (origin == CaptureOrigin.FRESH_THREAD) {
                // A fresh-thread capture belongs to the double-click toggle.
                // A colliding single click cannot send or cancel it.
                return Collections.emptyList();
            }
            return Collections.singletonList(origin == CaptureOrigin.CURRENT_THREAD
                    ? Action.STOP_AND_SEND
                    : Action.START_OR_INTERRUPT);
        }
        if (resolvedTapCount == 2) {
            if (origin == CaptureOrigin.FRESH_THREAD) {
                return Collections.singletonList(Action.STOP_AND_SEND);
            }
            List<Action> actions = new ArrayList<>();
            if (origin == CaptureOrigin.CURRENT_THREAD) {
                actions.add(Action.CANCEL_CAPTURE);
            }
            actions.add(Action.START_FRESH);
            return actions;
        }
        if (resolvedTapCount == 3) {
            List<Action> actions = new ArrayList<>();
            if (origin != CaptureOrigin.NONE) {
                actions.add(Action.CANCEL_CAPTURE);
            }
            actions.add(Action.OPEN_CHAT);
            return actions;
        }
        return Collections.emptyList();
    }

    void reset() {
        tapCount = 0;
    }
}

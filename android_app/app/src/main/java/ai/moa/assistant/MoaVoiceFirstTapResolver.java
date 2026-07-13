package ai.moa.assistant;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class MoaVoiceFirstTapResolver {
    enum Action {
        START_CONTINUE_TALK,
        START_FRESH_TALK,
        CANCEL_TALK_LOOP,
        COMMIT_AND_END_TALK,
        OPEN_CHAT
    }

    private enum Tap1Action {
        NONE,
        STARTED,
        SEND_PENDING
    }

    private int tapCount;
    private Tap1Action tap1Action = Tap1Action.NONE;
    private boolean tap2StartedFresh;

    boolean hasOpenChord() {
        return tapCount > 0;
    }

    List<Action> tapUp(boolean loopActive) {
        tapCount++;
        if (tapCount == 1) {
            tap2StartedFresh = false;
            if (loopActive) {
                tap1Action = Tap1Action.SEND_PENDING;
                return Collections.emptyList();
            }
            tap1Action = Tap1Action.STARTED;
            return one(Action.START_CONTINUE_TALK);
        }
        if (tapCount == 2) {
            List<Action> actions = new ArrayList<>();
            if (tap1Action == Tap1Action.STARTED || tap1Action == Tap1Action.SEND_PENDING) {
                actions.add(Action.CANCEL_TALK_LOOP);
            }
            tap1Action = Tap1Action.NONE;
            tap2StartedFresh = true;
            actions.add(Action.START_FRESH_TALK);
            return actions;
        }
        if (tapCount == 3) {
            List<Action> actions = new ArrayList<>();
            if (tap2StartedFresh) {
                actions.add(Action.CANCEL_TALK_LOOP);
            }
            tap2StartedFresh = false;
            actions.add(Action.OPEN_CHAT);
            return actions;
        }
        return Collections.emptyList();
    }

    List<Action> resolve() {
        int count = tapCount;
        Tap1Action first = tap1Action;
        reset();
        if (count == 1 && first == Tap1Action.SEND_PENDING) {
            return one(Action.COMMIT_AND_END_TALK);
        }
        return Collections.emptyList();
    }

    void reset() {
        tapCount = 0;
        tap1Action = Tap1Action.NONE;
        tap2StartedFresh = false;
    }

    private static List<Action> one(Action action) {
        return Collections.singletonList(action);
    }
}

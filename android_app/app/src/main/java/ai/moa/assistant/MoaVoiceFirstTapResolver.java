package ai.moa.assistant;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class MoaVoiceFirstTapResolver {
    enum Action {
        START_CONTINUE_TALK,
        START_FRESH_TALK,
        CANCEL_TALK_LOOP,
        OPEN_CHAT
    }

    private enum Tap1Action {
        NONE,
        ACTIVE_DRAFT
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
            tap1Action = Tap1Action.ACTIVE_DRAFT;
            if (loopActive) return Collections.emptyList();
            return one(Action.START_CONTINUE_TALK);
        }
        if (tapCount == 2) {
            List<Action> actions = new ArrayList<>();
            if (tap1Action == Tap1Action.ACTIVE_DRAFT) {
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
        reset();
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

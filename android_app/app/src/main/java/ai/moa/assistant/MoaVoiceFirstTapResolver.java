package ai.moa.assistant;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class MoaVoiceFirstTapResolver {
    enum Action {
        START_CONTINUE_TALK,
        START_FRESH_TALK,
        COMMIT_TALK_LOOP,
        CANCEL_TALK_LOOP,
        OPEN_CHAT
    }

    private enum Tap1Action {
        NONE,
        ACTIVE_DRAFT,
        COMMIT_FRESH_ON_RESOLVE
    }

    private int tapCount;
    private Tap1Action tap1Action = Tap1Action.NONE;
    private boolean tap2StartedFresh;
    private boolean freshLoopAwaitingSingleCommit;

    boolean hasOpenChord() {
        return tapCount > 0;
    }

    List<Action> tapUp(boolean loopActive) {
        tapCount++;
        if (tapCount == 1) {
            tap2StartedFresh = false;
            if (freshLoopAwaitingSingleCommit && loopActive) {
                // Do not commit on tap-up: this may still become a double or
                // triple chord, and a rapid multi-click must never send.
                tap1Action = Tap1Action.COMMIT_FRESH_ON_RESOLVE;
                return Collections.emptyList();
            }
            if (!loopActive) {
                // The service can end a loop independently of the gesture
                // resolver. Drop stale disposition state before starting the
                // next ordinary reviewable draft.
                freshLoopAwaitingSingleCommit = false;
            }
            tap1Action = Tap1Action.ACTIVE_DRAFT;
            if (loopActive) return Collections.emptyList();
            return one(Action.START_CONTINUE_TALK);
        }
        if (tapCount == 2) {
            tap1Action = Tap1Action.NONE;
            tap2StartedFresh = true;
            freshLoopAwaitingSingleCommit = false;
            // A fresh loop is parallel disposition, not permission to discard
            // the prior draft, message, or transcript.
            return one(Action.START_FRESH_TALK);
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
        List<Action> actions = Collections.emptyList();
        if (tapCount == 1 && tap1Action == Tap1Action.COMMIT_FRESH_ON_RESOLVE) {
            freshLoopAwaitingSingleCommit = false;
            actions = one(Action.COMMIT_TALK_LOOP);
        } else if (tapCount == 2 && tap2StartedFresh) {
            freshLoopAwaitingSingleCommit = true;
        }
        resetChord();
        return actions;
    }

    void reset() {
        resetChord();
    }

    private void resetChord() {
        tapCount = 0;
        tap1Action = Tap1Action.NONE;
        tap2StartedFresh = false;
    }

    private static List<Action> one(Action action) {
        return Collections.singletonList(action);
    }
}

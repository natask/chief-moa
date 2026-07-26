package ai.moa.assistant;

/** Resolves exactly one terminal action for an owned push-to-talk gesture. */
final class MoaPushToTalkFinish {
    enum Action { IGNORE, DEFER_UNTIL_OPEN, COMMIT_STREAMING, COMMIT_LOCAL }

    private boolean started;
    private boolean audioObserved;
    private boolean finished;

    void start() {
        started = true;
        audioObserved = false;
        finished = false;
    }

    void audioObserved() {
        if (started && !finished) audioObserved = true;
    }

    boolean hasAudioEvidence() {
        return audioObserved;
    }

    Action normalFinish(boolean branchPending, boolean controllerOwned, boolean localListening) {
        if (!started || finished) return Action.IGNORE;
        finished = true;
        if (branchPending && !controllerOwned) return Action.DEFER_UNTIL_OPEN;
        if (controllerOwned) return Action.COMMIT_STREAMING;
        if (localListening) return Action.COMMIT_LOCAL;
        return Action.IGNORE;
    }

    boolean intentionalCancel() {
        if (!started || finished) return false;
        finished = true;
        return true;
    }
}

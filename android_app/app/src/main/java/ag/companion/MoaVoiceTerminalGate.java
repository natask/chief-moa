package ag.companion;

/** One-shot gate that makes transport failure teardown terminal and idempotent. */
final class MoaVoiceTerminalGate {
    private boolean terminated;

    synchronized boolean beginTermination() {
        if (terminated) {
            return false;
        }
        terminated = true;
        return true;
    }

    synchronized boolean allowsEvents() {
        return !terminated;
    }

}

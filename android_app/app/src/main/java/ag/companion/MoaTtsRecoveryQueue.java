package ag.companion;

/** Turn-scoped event-order gate: suffix synthesis cannot start before prefix playback drains. */
final class MoaTtsRecoveryQueue {
    private String drainedTurnId = "";
    private Request pending;

    Request onTerminal(String turnId, String retryId, int fromTextChar,
            boolean prefixAudioRequiresDrain) {
        Request request = new Request(turnId, retryId, Math.max(0, fromTextChar));
        if (!request.valid()) {
            return null;
        }
        if (!prefixAudioRequiresDrain) {
            drainedTurnId = "";
            pending = null;
            return request;
        }
        if (request.turnId.equals(drainedTurnId)) {
            drainedTurnId = "";
            return request;
        }
        pending = request;
        return null;
    }

    Request onPlaybackDrained(String turnId) {
        String completed = safe(turnId);
        if (pending != null && pending.turnId.equals(completed)) {
            Request ready = pending;
            pending = null;
            return ready;
        }
        drainedTurnId = completed;
        return null;
    }

    boolean hasPending() {
        return pending != null;
    }

    void clear() {
        drainedTurnId = "";
        pending = null;
    }

    static final class Request {
        final String turnId;
        final String retryId;
        final int fromTextChar;

        Request(String turnId, String retryId, int fromTextChar) {
            this.turnId = safe(turnId);
            this.retryId = safe(retryId);
            this.fromTextChar = fromTextChar;
        }

        boolean valid() {
            return !turnId.isEmpty() && !retryId.isEmpty();
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

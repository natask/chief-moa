package ai.moa.assistant;

/** Pure failure plan used by every terminal draft transport path. */
final class MoaVoiceDraftFailurePolicy {
    enum Cause {
        SESSION_START_ENQUEUE,
        CONTROL_ENQUEUE,
        READY_TIMEOUT,
        CONTROL_ACK_TIMEOUT,
        SOCKET_CLOSED,
        SOCKET_FAILURE,
        GATEWAY_ERROR,
        CAPTURE_OR_AUDIO_FAILURE,
        SEND_ENQUEUE,
        PRE_SEND_EXECUTION_EVENT,
        INVALID_AUTHORITY,
        INVALID_TERMINAL_RECEIPT
    }

    static final class Plan {
        final Cause cause;
        final boolean stopCapture;
        final boolean destroySocket;
        final boolean sendDraftCommit;
        final boolean sendCanonicalCancelTurn;
        final boolean preserveValidatedParkedPointer;
        final boolean preserveUnvalidatedPointer;
        final boolean retryableError;

        Plan(Cause cause) {
            this.cause = cause;
            stopCapture = true;
            destroySocket = true;
            sendDraftCommit = false;
            sendCanonicalCancelTurn = false;
            preserveValidatedParkedPointer = true;
            preserveUnvalidatedPointer = false;
            retryableError = true;
        }
    }

    private MoaVoiceDraftFailurePolicy() {
    }

    static Plan terminal(Cause cause) {
        if (cause == null) {
            throw new IllegalArgumentException("draft failure cause is required");
        }
        return new Plan(cause);
    }
}

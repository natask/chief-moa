package ai.moa.assistant;

/**
 * Session-scoped admission for asynchronous socket/capture failures. A local
 * teardown can race both the transport callback and main-thread delivery, so
 * callers check the same generation at both boundaries.
 */
final class MoaVoiceFailureAdmission {
    private int generation;
    private boolean locallyTerminated;

    synchronized int beginSession() {
        generation++;
        locallyTerminated = false;
        return generation;
    }

    synchronized void markLocalTermination() {
        locallyTerminated = true;
    }

    synchronized int currentGeneration() {
        return generation;
    }

    synchronized boolean isCurrentSession(int candidateGeneration) {
        return candidateGeneration == generation;
    }

    synchronized boolean shouldReportFailure(int candidateGeneration) {
        return candidateGeneration == generation && !locallyTerminated;
    }

    /** Entry point shared by the real socket callback and deterministic tests. */
    boolean onSocketFailure(int candidateGeneration, Runnable admittedFailure) {
        if (!shouldReportFailure(candidateGeneration)) {
            return false;
        }
        admittedFailure.run();
        return true;
    }
}

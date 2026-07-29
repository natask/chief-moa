package ag.companion;

/**
 * Exact authority gate for asynchronous Overlay voice continuations.
 *
 * <p>The gate runs the production effect only when the service, branch-switch
 * token, streaming generation, controller identity, and pending-release token
 * still describe the operation that originally scheduled it.</p>
 */
final class MoaStreamingVoiceContinuationGate {
    private MoaStreamingVoiceContinuationGate() {
    }

    static boolean runResolvedBranch(
            boolean serviceRunning,
            long expectedSwitchToken,
            long currentSwitchToken,
            Runnable continuation
    ) {
        if (!serviceRunning
                || expectedSwitchToken != currentSwitchToken
                || continuation == null) {
            return false;
        }
        continuation.run();
        return true;
    }

    static boolean runQueuedCommit(
            boolean serviceRunning,
            int expectedGeneration,
            int currentGeneration,
            Object expectedController,
            Object currentController,
            long expectedReleaseToken,
            long currentReleaseToken,
            Runnable continuation
    ) {
        if (!serviceRunning
                || expectedGeneration != currentGeneration
                || expectedController == null
                || expectedController != currentController
                || expectedReleaseToken != currentReleaseToken
                || continuation == null) {
            return false;
        }
        continuation.run();
        return true;
    }
}

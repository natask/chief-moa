package ai.moa.assistant;

/** Pure ordering seam that keeps completed turns from flushing an active device drain. */
final class MoaVoicePlaybackDrainGate {
    private boolean playbackStarted;
    private boolean drainInFlight;
    private boolean deviceCompletionPending;

    void reset() {
        playbackStarted = false;
        drainInFlight = false;
        deviceCompletionPending = false;
    }

    void onPlaybackStarted() {
        playbackStarted = true;
    }

    boolean onProviderAudioDone(boolean playbackEnabled) {
        drainInFlight = playbackEnabled && playbackStarted;
        deviceCompletionPending = drainInFlight;
        return !drainInFlight;
    }

    boolean shouldStopOnTurnDone(String status) {
        if (!"completed".equals(status)) return true;
        return playbackStarted && !drainInFlight;
    }

    boolean ownsCompletedTurn() {
        return drainInFlight;
    }

    boolean onPlaybackStopped(boolean drained) {
        boolean deliverDeviceCompletion = deviceCompletionPending && drained;
        drainInFlight = false;
        playbackStarted = false;
        deviceCompletionPending = false;
        return deliverDeviceCompletion;
    }
}

package ai.moa.assistant;

/** Pure ordering seam that keeps completed turns from flushing an active device drain. */
final class MoaVoicePlaybackDrainGate {
    private boolean playbackStarted;
    private boolean drainInFlight;

    void reset() {
        playbackStarted = false;
        drainInFlight = false;
    }

    void onPlaybackStarted() {
        playbackStarted = true;
    }

    void onAudioDone(boolean playbackEnabled) {
        drainInFlight = playbackEnabled && playbackStarted;
    }

    boolean shouldStopOnTurnDone(String status) {
        if (!"completed".equals(status)) return true;
        return playbackStarted && !drainInFlight;
    }

    boolean ownsCompletedTurn() {
        return drainInFlight;
    }

    void onPlaybackStopped() {
        drainInFlight = false;
        playbackStarted = false;
    }
}

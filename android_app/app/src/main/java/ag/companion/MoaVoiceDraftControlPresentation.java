package ag.companion;

/** Pure presentation state for the bounded controls adjacent to the mascot. */
final class MoaVoiceDraftControlPresentation {
    final boolean visible;
    final String pauseLabel;

    private MoaVoiceDraftControlPresentation(boolean visible, String pauseLabel) {
        this.visible = visible;
        this.pauseLabel = pauseLabel;
    }

    static MoaVoiceDraftControlPresentation from(boolean capabilitySupported,
            boolean draftReady, boolean paused) {
        boolean visible = capabilitySupported && draftReady;
        return new MoaVoiceDraftControlPresentation(visible, paused ? "Resume" : "Pause");
    }
}

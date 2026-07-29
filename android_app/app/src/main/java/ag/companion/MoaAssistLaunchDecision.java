package ag.companion;

final class MoaAssistLaunchDecision {
    enum Action {
        START_VOICE_SERVICE,
        SHOW_PERMISSION_HINT
    }

    private MoaAssistLaunchDecision() {
    }

    static Action decide(boolean overlayPermissionGranted, boolean microphonePermissionGranted) {
        return overlayPermissionGranted && microphonePermissionGranted
                ? Action.START_VOICE_SERVICE
                : Action.SHOW_PERMISSION_HINT;
    }

    static String permissionHint(boolean overlayPermissionGranted, boolean microphonePermissionGranted) {
        if (!overlayPermissionGranted && !microphonePermissionGranted) {
            return "Long-press Ag, open Settings, then grant overlay and microphone permissions.";
        }
        if (!overlayPermissionGranted) {
            return "Long-press Ag, open Settings, then grant overlay permission.";
        }
        return "Long-press Ag, open Settings, then grant microphone permission.";
    }
}

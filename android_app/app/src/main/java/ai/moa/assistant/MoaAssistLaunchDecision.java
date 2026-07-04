package ai.moa.assistant;

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
            return "Open A.G. once to grant overlay and microphone permissions.";
        }
        if (!overlayPermissionGranted) {
            return "Open A.G. once to grant overlay permission.";
        }
        return "Open A.G. once to grant microphone permission.";
    }
}

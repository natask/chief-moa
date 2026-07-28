package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaAssistLaunchDecisionTest {
    @Test
    public void grantedPermissionsStartVoiceService() {
        assertEquals(
                MoaAssistLaunchDecision.Action.START_VOICE_SERVICE,
                MoaAssistLaunchDecision.decide(true, true)
        );
    }

    @Test
    public void missingPermissionsShowHintInsteadOfSetup() {
        assertEquals(
                MoaAssistLaunchDecision.Action.SHOW_PERMISSION_HINT,
                MoaAssistLaunchDecision.decide(false, true)
        );
        assertEquals(
                MoaAssistLaunchDecision.Action.SHOW_PERMISSION_HINT,
                MoaAssistLaunchDecision.decide(true, false)
        );
        assertEquals(
                MoaAssistLaunchDecision.Action.SHOW_PERMISSION_HINT,
                MoaAssistLaunchDecision.decide(false, false)
        );
    }

    @Test
    public void everyPermissionStateAvoidsOpeningSettingsFromAssist() {
        for (boolean overlayGranted : new boolean[]{false, true}) {
            for (boolean microphoneGranted : new boolean[]{false, true}) {
                MoaAssistLaunchDecision.Action action =
                        MoaAssistLaunchDecision.decide(overlayGranted, microphoneGranted);
                assertEquals(
                        overlayGranted && microphoneGranted
                                ? MoaAssistLaunchDecision.Action.START_VOICE_SERVICE
                                : MoaAssistLaunchDecision.Action.SHOW_PERMISSION_HINT,
                        action
                );
            }
        }
    }

    @Test
    public void permissionHintsNameTheMissingPermission() {
        assertEquals(
                "Long-press AG, open Settings, then grant overlay and microphone permissions.",
                MoaAssistLaunchDecision.permissionHint(false, false)
        );
        assertEquals(
                "Long-press AG, open Settings, then grant overlay permission.",
                MoaAssistLaunchDecision.permissionHint(false, true)
        );
        assertEquals(
                "Long-press AG, open Settings, then grant microphone permission.",
                MoaAssistLaunchDecision.permissionHint(true, false)
        );
    }
}

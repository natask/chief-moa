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
    public void permissionHintsNameTheMissingPermission() {
        assertEquals(
                "Long-press A.G., open Settings, then grant overlay and microphone permissions.",
                MoaAssistLaunchDecision.permissionHint(false, false)
        );
        assertEquals(
                "Long-press A.G., open Settings, then grant overlay permission.",
                MoaAssistLaunchDecision.permissionHint(false, true)
        );
        assertEquals(
                "Long-press A.G., open Settings, then grant microphone permission.",
                MoaAssistLaunchDecision.permissionHint(true, false)
        );
    }
}

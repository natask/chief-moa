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
                "Open Moa once to grant overlay and microphone permissions.",
                MoaAssistLaunchDecision.permissionHint(false, false)
        );
        assertEquals(
                "Open Moa once to grant overlay permission.",
                MoaAssistLaunchDecision.permissionHint(false, true)
        );
        assertEquals(
                "Open Moa once to grant microphone permission.",
                MoaAssistLaunchDecision.permissionHint(true, false)
        );
    }
}

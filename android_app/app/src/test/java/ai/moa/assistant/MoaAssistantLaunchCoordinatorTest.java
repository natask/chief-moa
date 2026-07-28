package ai.moa.assistant;

import android.content.Intent;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaAssistantLaunchCoordinatorTest {
    @Test
    public void recognizesEverySystemAssistantAction() {
        assertTrue(MoaAssistantLaunchCoordinator.isAssistAction(Intent.ACTION_ASSIST));
        assertTrue(MoaAssistantLaunchCoordinator.isAssistAction(
                MoaAssistantLaunchCoordinator.ACTION_VOICE_ASSIST));
        assertTrue(MoaAssistantLaunchCoordinator.isAssistAction(
                MoaAssistantLaunchCoordinator.ACTION_VOICE_COMMAND));
    }

    @Test
    public void doesNotTreatSettingsOrLauncherActionsAsSystemAssist() {
        assertFalse(MoaAssistantLaunchCoordinator.isAssistAction(Intent.ACTION_MAIN));
        assertFalse(MoaAssistantLaunchCoordinator.isAssistAction("ai.moa.assistant.action.SHOW_CONTROL_CENTER"));
        assertFalse(MoaAssistantLaunchCoordinator.isAssistAction(null));
    }
}

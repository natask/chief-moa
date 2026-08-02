package ag.companion;

import android.content.Intent;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaInvocationResolverTest {
    @Test
    public void normalLauncherAndDictationShortcutResolveToLiteralDictation() {
        assertEquals(
                MoaInvocationResolver.Invocation.DICTATION,
                MoaInvocationResolver.resolve(Intent.ACTION_MAIN));
        assertEquals(
                MoaInvocationResolver.Invocation.DICTATION,
                MoaInvocationResolver.resolve(MoaInvocationResolver.ACTION_DICTATION));
    }

    @Test
    public void explicitShortcutsResolveToTheirTypedDestinations() {
        assertEquals(
                MoaInvocationResolver.Invocation.ASSISTANT,
                MoaInvocationResolver.resolve(MoaInvocationResolver.ACTION_ASSISTANT));
        assertEquals(
                MoaInvocationResolver.Invocation.HANDS_FREE,
                MoaInvocationResolver.resolve(MoaInvocationResolver.ACTION_HANDS_FREE));
        assertEquals(
                MoaInvocationResolver.Invocation.CONTROL_CENTER,
                MoaInvocationResolver.resolve(MoaInvocationResolver.ACTION_CONTROL_CENTER));
    }

    @Test
    public void systemAndUnknownActionsKeepAssistantSafeDefault() {
        assertEquals(
                MoaInvocationResolver.Invocation.ASSISTANT,
                MoaInvocationResolver.resolve(Intent.ACTION_ASSIST));
        assertEquals(
                MoaInvocationResolver.Invocation.ASSISTANT,
                MoaInvocationResolver.resolve(MoaAssistantLaunchCoordinator.ACTION_VOICE_ASSIST));
        assertEquals(
                MoaInvocationResolver.Invocation.ASSISTANT,
                MoaInvocationResolver.resolve(MoaAssistantLaunchCoordinator.ACTION_VOICE_COMMAND));
        assertEquals(
                MoaInvocationResolver.Invocation.ASSISTANT,
                MoaInvocationResolver.resolve(null));
        assertEquals(
                MoaInvocationResolver.Invocation.ASSISTANT,
                MoaInvocationResolver.resolve("unrecognized"));
    }
}

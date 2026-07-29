package ag.companion;

import org.junit.Test;

import java.util.EnumMap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

public final class AgOnboardingStateTest {
    @Test public void initialPathChoosesFirstIncompleteLiveCapability() {
        AgOnboardingState state = new AgOnboardingState(null);
        assertEquals(AgOnboardingState.Capability.CONNECTION,
                state.nextRequired(new AgOnboardingState.LiveState(false, false, false, false)));
        assertEquals(AgOnboardingState.Capability.MICROPHONE,
                state.nextRequired(new AgOnboardingState.LiveState(true, false, false, false)));
        assertEquals(AgOnboardingState.Capability.FIRST_CONVERSATION,
                state.nextRequired(new AgOnboardingState.LiveState(true, true, false, false)));
        assertEquals(AgOnboardingState.Capability.NOTIFICATIONS,
                state.nextRequired(new AgOnboardingState.LiveState(true, true, true, false)));
        assertNull(state.nextRequired(new AgOnboardingState.LiveState(true, true, true, true)));
    }

    @Test public void revokedLiveCapabilityOverridesCachedSuccess() {
        EnumMap<AgOnboardingState.Capability, AgOnboardingState.Stage> cached =
                new EnumMap<>(AgOnboardingState.Capability.class);
        cached.put(AgOnboardingState.Capability.MICROPHONE, AgOnboardingState.Stage.DEMONSTRATED);
        AgOnboardingState state = new AgOnboardingState(cached);
        assertEquals(AgOnboardingState.Stage.RETURNED, state.stage(
                AgOnboardingState.Capability.MICROPHONE,
                new AgOnboardingState.LiveState(true, false, true, true)));
    }

    @Test public void instructionalTransitionCannotClaimVerifiedSuccess() {
        assertThrows(IllegalArgumentException.class, () -> AgOnboardingState.transition(
                AgOnboardingState.Stage.RETURNED, AgOnboardingState.Stage.VERIFIED_ENABLED));
    }
}

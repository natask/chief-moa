package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaAssistantOutputStateTest {
    @Test
    public void steeringKeepsReceivedTextEligibleButSuppressesSpeech() {
        MoaAssistantOutputState state = new MoaAssistantOutputState();
        state.begin("turn-old");

        state.suppressSpeech();

        assertTrue(state.allowsText("turn-old"));
        assertFalse(state.allowsSpeech("turn-old"));
    }

    @Test
    public void newTurnCannotBeOverwrittenByStaleAssistantOutput() {
        MoaAssistantOutputState state = new MoaAssistantOutputState();
        state.begin("turn-old");
        state.suppressSpeech();
        state.begin("turn-new");

        assertFalse(state.allowsText("turn-old"));
        assertFalse(state.allowsSpeech("turn-old"));
        assertTrue(state.allowsText("turn-new"));
        assertTrue(state.allowsSpeech("turn-new"));
    }
}

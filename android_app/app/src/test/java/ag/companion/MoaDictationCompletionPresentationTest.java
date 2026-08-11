package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaDictationCompletionPresentationTest {
    @Test
    public void dictationKeepsFinalUserTextWithoutAssistantPlaceholder() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.finalizeUser("turn-1", "Keep this dictated text.");

        state.finishAssistantPlayback("turn-1", "");

        assertEquals("Keep this dictated text.", state.userText());
        assertFalse(state.assistantPlaceholder());
        assertFalse(state.assistantCaret());
        assertEquals("", state.assistantCollapsedText());
    }

    @Test
    public void dictationStopBeforeFinalEndsListeningWithoutAssistantPlaceholder() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.updateUserPartial("turn-1", "Still waiting for final");

        state.awaitAssistant("turn-1");
        state.finishAssistantPlayback("turn-1", "");

        assertEquals("Still waiting for final", state.userText());
        assertFalse(state.userListening());
        assertFalse(state.assistantPlaceholder());
        assertFalse(state.assistantCaret());
    }

    @Test
    public void normalConversationStillShowsAssistantPlaceholder() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.finalizeUser("turn-1", "Answer this question.");

        assertTrue(state.assistantPlaceholder());
        assertTrue(state.assistantCaret());
    }
}

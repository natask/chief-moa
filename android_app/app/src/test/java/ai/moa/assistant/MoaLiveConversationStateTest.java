package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaLiveConversationStateTest {
    @Test
    public void invocationShowsListeningPlaceholderBeforeText() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");

        assertTrue(state.userPlaceholder());
        assertTrue(state.userListening());
        assertEquals("", state.userText());
    }

    @Test
    public void newestPartialTokenIsTheOnlyUnstableSuffix() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        assertTrue(state.updateUserPartial("turn-1", "please open calend"));

        assertEquals("please open ".length(), state.userUnstableStart());
        assertTrue(state.finalizeUser("turn-1", "please open calendar"));
        assertEquals("please open calendar".length(), state.userUnstableStart());
        assertFalse(state.userListening());
        assertTrue(state.assistantPlaceholder());
    }

    @Test
    public void fullDisplayTextWaitsWhileOnlyPlaybackLedgerTextStreams() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.finalizeUser("turn-1", "question");
        state.setAssistantFullText("turn-1", "A longer complete display answer.");

        assertEquals("", state.assistantCollapsedText());
        state.startAssistantPlayback("turn-1");
        state.advanceAssistantPlayback("turn-1", "Short spoken reply.", 6);
        assertEquals("Short ", state.assistantCollapsedText());
        assertEquals("A longer complete display answer.", state.assistantFullText());

        state.finishAssistantPlayback("turn-1", "Short spoken reply.");
        assertEquals("A longer complete display answer.", state.assistantCollapsedText());
    }

    @Test
    public void staleTurnCannotMutateReplacementAndProgressNeverRewinds() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("new");
        assertFalse(state.updateUserPartial("old", "stale"));
        assertEquals("", state.userText());

        state.finalizeUser("new", "hello");
        state.startAssistantPlayback("new");
        state.advanceAssistantPlayback("new", "one two three", 9);
        state.advanceAssistantPlayback("new", "one two three", 4);
        assertEquals("one two t", state.assistantCollapsedText());
        assertFalse(state.advanceAssistantPlayback("old", "stale", 5));
        assertEquals("one two t", state.assistantCollapsedText());
    }

    @Test
    public void clearRemovesNoSpeechPlaceholders() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.awaitAssistant("turn-1");
        assertTrue(state.assistantPlaceholder());
        state.clear();
        assertFalse(state.userPlaceholder());
        assertFalse(state.assistantPlaceholder());
    }
}

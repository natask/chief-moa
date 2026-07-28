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
    public void segmentReceiptWithZeroPlaybackProgressRevealsNothing() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.finalizeUser("turn-1", "question");
        state.startAssistantPlayback("turn-1");

        // The whole spoken ledger arrives over the network before the
        // AudioTrack head has crossed a single frame: nothing may be revealed.
        assertTrue(state.advanceAssistantPlayback("turn-1", "Full spoken reply text.", 0));
        assertEquals("", state.assistantCollapsedText());
        assertTrue(state.assistantPlaceholder());

        assertTrue(state.advanceAssistantPlayback("turn-1", "Full spoken reply text.", 4));
        assertEquals("Full", state.assistantCollapsedText());
        assertFalse(state.assistantPlaceholder());
    }

    @Test
    public void partialAfterCommitStillFillsTheSameEntry() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.updateUserPartial("turn-1", "turn on the");
        state.awaitAssistant("turn-1");

        assertTrue(state.assistantPlaceholder());
        assertTrue(state.updateUserPartial("turn-1", "turn on the lights"));
        assertEquals("turn on the lights", state.userText());
        assertFalse(state.userListening());
        assertTrue(state.assistantPlaceholder());
    }

    @Test
    public void unstableTokenEdgesAreHonest() {
        assertEquals(0, MoaLiveConversationState.newestTokenStart("hello"));
        assertEquals(0, MoaLiveConversationState.newestTokenStart(""));
        assertEquals("hello ".length(),
                MoaLiveConversationState.newestTokenStart("hello world"));
    }

    @Test
    public void providerAudioDoneAloneDoesNotFinishPlayback() {
        MoaLiveConversationState state = new MoaLiveConversationState();
        state.begin("turn-1");
        state.finalizeUser("turn-1", "question");
        state.setAssistantFullText("turn-1", "The complete reply.");
        state.startAssistantPlayback("turn-1");
        state.advanceAssistantPlayback("turn-1", "The complete reply.", 3);

        // Only the device-drain completion path calls finishAssistantPlayback;
        // until then the collapsed view must keep tracking the playback head.
        assertEquals("The", state.assistantCollapsedText());
        state.finishAssistantPlayback("turn-1", "");
        assertEquals("The complete reply.", state.assistantCollapsedText());
        assertFalse(state.assistantCaret());
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

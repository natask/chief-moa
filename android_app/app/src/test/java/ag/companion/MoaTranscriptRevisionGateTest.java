package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

public final class MoaTranscriptRevisionGateTest {
    @Test
    public void correctedPrefixUsesAuthoritativeWholeSnapshotAndKeepsGatewayTail() throws Exception {
        MoaTranscriptRevisionGate gate = new MoaTranscriptRevisionGate("session-1", "branch-1", "turn-1");
        assertNotNull(gate.acceptProviderSnapshot("turn-1", "old words live tail", 4L, false));

        MoaTranscriptRevisionGate.Snapshot corrected = gate.acceptPrefixRevision(prefix(5L, 1L)
                .put("finalized_text", "better words")
                .put("unsealed_text", " live tail")
                .put("text", "better words live tail"));

        assertNotNull(corrected);
        assertEquals("better words live tail", corrected.text);
        assertEquals(5L, corrected.transcriptSequence);
    }

    @Test
    public void staleOutOfOrderAndDuplicateRollingRevisionsAreIgnored() throws Exception {
        MoaTranscriptRevisionGate gate = new MoaTranscriptRevisionGate("session-1", "branch-1", "turn-1");
        assertNotNull(gate.acceptPrefixRevision(prefix(8L, 2L)));
        assertNull(gate.acceptPrefixRevision(prefix(8L, 3L)));
        assertNull(gate.acceptPrefixRevision(prefix(9L, 2L)));
        assertNull(gate.acceptPrefixRevision(prefix(7L, 4L)));
        assertNull(gate.acceptProviderSnapshot("turn-1", "late ordinary partial", 7L, false));
    }

    @Test
    public void wrongSessionBranchTurnOrSpeakerCannotChangeLiveText() throws Exception {
        MoaTranscriptRevisionGate gate = new MoaTranscriptRevisionGate("session-1", "branch-1", "turn-1");
        assertNull(gate.acceptPrefixRevision(prefix(1L, 1L).put("session_id", "session-2")));
        assertNull(gate.acceptPrefixRevision(prefix(1L, 1L).put("branch_id", "branch-2")));
        assertNull(gate.acceptPrefixRevision(prefix(1L, 1L).put("turn_id", "turn-2")));
        assertNull(gate.acceptPrefixRevision(prefix(1L, 1L).put("speaker", "assistant")));
    }

    @Test
    public void prefixRevisionRequiresExplicitTailAndNeverInfersOverlap() throws Exception {
        MoaTranscriptRevisionGate gate = new MoaTranscriptRevisionGate("session-1", "branch-1", "turn-1");
        JSONObject noTail = prefix(1L, 1L);
        noTail.remove("unsealed_text");
        JSONObject noPrefix = prefix(1L, 1L);
        noPrefix.remove("finalized_text");
        JSONObject noText = prefix(1L, 1L);
        noText.remove("text");
        assertNull(gate.acceptPrefixRevision(noTail));
        assertNull(gate.acceptPrefixRevision(noPrefix));
        assertNull(gate.acceptPrefixRevision(noText));
    }

    @Test
    public void completedRevisionChangesOnlyExactOlderFinalizedUserMessage() throws Exception {
        ChatMessage target = finalized("session-1", "branch-1", "turn-1", 1L);
        JSONObject event = completed(2L);

        MoaTranscriptRevisionGate.Snapshot accepted =
                MoaTranscriptRevisionGate.acceptCompletedMessage(event, target, "session-1", "branch-1", "");
        assertNotNull(accepted);
        assertEquals("corrected final", accepted.text);
        assertNull(MoaTranscriptRevisionGate.acceptCompletedMessage(completed(1L), target,
                "session-1", "branch-1", ""));
        assertNull(MoaTranscriptRevisionGate.acceptCompletedMessage(event, target,
                "session-1", "branch-1", "turn-1"));
        assertNull(MoaTranscriptRevisionGate.acceptCompletedMessage(
                new JSONObject(event.toString()).put("turn_id", "turn-2"), target,
                "session-1", "branch-1", ""));
        assertNull(MoaTranscriptRevisionGate.acceptCompletedMessage(
                new JSONObject(event.toString()).put("message_id", "wrong"), target,
                "session-1", "branch-1", ""));
        assertNull(MoaTranscriptRevisionGate.acceptCompletedMessage(event,
                new ChatMessage(true, "assistant"), "session-1", "branch-1", ""));
    }

    @Test
    public void finalSnapshotSealsLiveStateAgainstLaterPrefixCorrection() throws Exception {
        MoaTranscriptRevisionGate gate = new MoaTranscriptRevisionGate("session-1", "branch-1", "turn-1");
        assertNotNull(gate.acceptProviderSnapshot("turn-1", "final words", 10L, true));
        assertNull(gate.acceptPrefixRevision(prefix(11L, 1L)));
    }

    private static JSONObject prefix(long sequence, long revision) throws Exception {
        return new JSONObject()
                .put("type", "transcript_prefix_revision")
                .put("session_id", "session-1")
                .put("branch_id", "branch-1")
                .put("turn_id", "turn-1")
                .put("speaker", "user")
                .put("transcript_sequence", sequence)
                .put("revision", revision)
                .put("finalized_text", "better words")
                .put("unsealed_text", " live tail")
                .put("text", "better words live tail")
                .put("sealed_through_audio_byte", 32000L);
    }

    private static JSONObject completed(long revision) throws Exception {
        return new JSONObject()
                .put("type", "transcript_revision")
                .put("session_id", "session-1")
                .put("branch_id", "branch-1")
                .put("turn_id", "turn-1")
                .put("speaker", "user")
                .put("message_id", "turn:session-1:branch-1:turn-1:user")
                .put("revision", revision)
                .put("text", "corrected final");
    }

    private static ChatMessage finalized(String session, String branch, String turn, long revision) {
        return new ChatMessage(false, "original final", false, session, branch, turn, revision, true);
    }
}

package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceDraftSessionStateTest {
    @Test
    public void preReadyDiscardStaysQueuedUntilAuthorityBinds() throws Exception {
        MoaVoiceDraftSessionState state = freshState();
        assertTrue(state.requestControl(MoaVoiceDraftSessionState.Action.DISCARD, "discard-stable"));
        assertNull(state.reserveControlToSend());

        assertTrue(state.bindReady(ready("create", "draft-1", 1L)));
        MoaVoiceDraftSessionState.ControlRequest request = state.reserveControlToSend();
        assertNotNull(request);
        assertEquals(MoaVoiceDraftSessionState.Action.DISCARD, request.action);
        assertEquals("discard-stable", request.idempotencyKey);
        assertEquals(1L, request.authority.revision);
    }

    @Test
    public void resumeRequiresStrictlyNewerAuthoritativeReadyBeforeCapture() throws Exception {
        MoaVoiceDraftPointer parked = pointer("draft-1", 3L);
        MoaVoiceDraftSessionState state = new MoaVoiceDraftSessionState(
                "session-1",
                "branch-1",
                "turn-1",
                parked
        );

        assertFalse(state.bindReady(ready("resume", "draft-1", 3L)));
        assertFalse(state.isReady());
        assertTrue(state.bindReady(ready("resume", "draft-1", 4L)));
        assertTrue(state.isReady());
    }

    @Test
    public void controlReservationAdmitsAckBeforeWebSocketSendReturns() throws Exception {
        MoaVoiceDraftSessionState state = readyState();
        assertTrue(state.requestControl(MoaVoiceDraftSessionState.Action.PAUSE, "pause-stable"));

        // reserveControlToSend is the atomic boundary immediately before the
        // socket enqueue. The ACK is deliberately delivered before any later
        // send-return/mark step exists.
        assertNotNull(state.reserveControlToSend());
        MoaVoiceDraftSessionState.ControlAck accepted = state.acceptControlAck(
                ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused")
        );
        assertNotNull(accepted);
        assertEquals(MoaVoiceDraftSessionState.Action.PAUSE, accepted.action);
        assertEquals(2L, accepted.authority.revision);
        assertFalse(state.hasPendingControl());
    }

    @Test
    public void failedControlEnqueueCanRollbackOnlyItsExactReservation() throws Exception {
        MoaVoiceDraftSessionState state = readyState();
        assertTrue(state.requestControl(MoaVoiceDraftSessionState.Action.PARK, "park-stable"));
        assertNotNull(state.reserveControlToSend());
        state.rollbackControlReservation(MoaVoiceDraftSessionState.Action.PAUSE, "park-stable");
        assertTrue(state.isAwaitingControlAck());
        state.rollbackControlReservation(MoaVoiceDraftSessionState.Action.PARK, "park-stable");
        assertFalse(state.isAwaitingControlAck());
        assertNotNull(state.reserveControlToSend());
    }

    @Test
    public void ackMustMatchKnownTypeActionCompleteAuthorityAndNewerRevision() throws Exception {
        MoaVoiceDraftSessionState state = readyState();
        assertTrue(state.requestControl(MoaVoiceDraftSessionState.Action.PAUSE, "pause-stable"));
        assertNotNull(state.reserveControlToSend());

        assertNull(state.acceptControlAck(
                ack("voice_draft_control_ack", "pause", "draft-1", 1L, "paused")
        ));
        assertNull(state.acceptControlAck(
                ack("voice_draft_state", "pause", "draft-1", 2L, "paused")
        ));
        assertNull(state.acceptControlAck(
                ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused")
                        .put("branch_id", "other")
        ));
        assertNull(state.acceptControlAck(
                ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused")
                        .put("sessionId", "session-1")
        ));
        assertNull(state.acceptControlAck(
                ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused")
                        .put("session_id", " session-1 ")
        ));
        JSONObject hostileNestedId = ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused");
        hostileNestedId.getJSONObject("draft").put("id", "../draft-1");
        assertNull(state.acceptControlAck(hostileNestedId));
        JSONObject overlongNestedBranch = ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused");
        overlongNestedBranch.getJSONObject("draft").put("branch_id", "b".repeat(121));
        assertNull(state.acceptControlAck(overlongNestedBranch));

        assertNotNull(state.acceptControlAck(
                ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused")
        ));
    }

    @Test
    public void releaseAndReadyCannotLoseWakeupInEitherOrdering() throws Exception {
        MoaVoiceDraftSessionState releaseFirst = freshState();
        assertTrue(releaseFirst.bindReady(ready("create", "draft-1", 1L)));
        assertTrue(releaseFirst.requestCommit());
        assertTrue(releaseFirst.markTransportReady());
        assertNotNull(releaseFirst.reserveCommitAuthority());

        MoaVoiceDraftSessionState readyFirst = freshState();
        assertTrue(readyFirst.bindReady(ready("create", "draft-1", 1L)));
        assertFalse(readyFirst.markTransportReady());
        assertTrue(readyFirst.requestCommit());
        assertNotNull(readyFirst.reserveCommitAuthority());
    }

    @Test
    public void cancelDuringInflightPauseQueuesDiscardOnNewerAuthorityAndBlocksSend() throws Exception {
        MoaVoiceDraftSessionState state = readyState();
        assertTrue(state.requestControl(MoaVoiceDraftSessionState.Action.PAUSE, "pause-stable"));
        assertNotNull(state.reserveControlToSend());

        assertTrue(state.requestControl(MoaVoiceDraftSessionState.Action.DISCARD, "discard-stable"));
        assertTrue(state.isTerminalCancellationLatched());
        assertFalse(state.requestCommit());

        MoaVoiceDraftSessionState.ControlAck pauseAck = state.acceptControlAck(
                ack("voice_draft_control_ack", "pause", "draft-1", 2L, "paused")
        );
        assertNotNull(pauseAck);
        assertEquals(MoaVoiceDraftSessionState.Action.DISCARD, pauseAck.queuedAction);

        MoaVoiceDraftSessionState.ControlRequest discard = state.reserveControlToSend();
        assertNotNull(discard);
        assertEquals(MoaVoiceDraftSessionState.Action.DISCARD, discard.action);
        assertEquals(2L, discard.authority.revision);
        MoaVoiceDraftSessionState.ControlAck discardAck = state.acceptControlAck(
                ack("voice_draft_control_ack", "discard", "draft-1", 3L, "discarded")
        );
        assertNotNull(discardAck);
        assertFalse(state.hasPendingControl());
    }

    @Test
    public void readyAndControlTimeoutPhasesAreExplicitAndCancelable() throws Exception {
        MoaVoiceDraftSessionState state = freshState();
        assertTrue(state.isAwaitingReadyAck());
        assertFalse(state.isAwaitingControlAck());
        assertTrue(state.bindReady(ready("create", "draft-1", 1L)));
        assertFalse(state.isAwaitingReadyAck());

        assertTrue(state.requestControl(MoaVoiceDraftSessionState.Action.PARK, "park-stable"));
        assertFalse(state.isAwaitingControlAck());
        assertNotNull(state.reserveControlToSend());
        assertTrue(state.isAwaitingControlAck());
        assertNotNull(state.acceptControlAck(
                ack("voice_draft_control_ack", "park", "draft-1", 2L, "parked")
        ));
        assertFalse(state.isAwaitingControlAck());
        assertTrue(MoaStreamingVoiceSessionController.DRAFT_READY_TIMEOUT_MS > 0L);
        assertTrue(MoaStreamingVoiceSessionController.DRAFT_READY_TIMEOUT_MS <= 30_000L);
        assertTrue(MoaStreamingVoiceSessionController.DRAFT_CONTROL_ACK_TIMEOUT_MS > 0L);
        assertTrue(MoaStreamingVoiceSessionController.DRAFT_CONTROL_ACK_TIMEOUT_MS <= 30_000L);
    }

    @Test
    public void terminalReceiptUsesSentOrDiscardedAndCompleteTopLevelAndNestedAuthority() throws Exception {
        MoaVoiceDraftSessionState state = readyState();
        assertTrue(state.requestCommit());
        assertNotNull(state.reserveCommitAuthority());

        assertNull(state.acceptTerminalReceipt(terminal("consumed", 2L)));
        JSONObject missingTopLevelSession = terminal("sent", 2L);
        missingTopLevelSession.remove("session_id");
        assertNull(state.acceptTerminalReceipt(missingTopLevelSession));
        assertNull(state.acceptTerminalReceipt(terminal("sent", 2L).put("branch_id", "other")));
        assertNull(state.acceptTerminalReceipt(terminal("sent", 2L).put("turn_id", "other")));
        JSONObject wrongNestedBranch = terminal("sent", 2L);
        wrongNestedBranch.getJSONObject("draft").put("branch_id", "other");
        assertNull(state.acceptTerminalReceipt(wrongNestedBranch));
        JSONObject nestedCompatibilityAlias = terminal("sent", 2L);
        nestedCompatibilityAlias.getJSONObject("draft").put("draft_id", "draft-1");
        assertNull(state.acceptTerminalReceipt(nestedCompatibilityAlias));
        assertNull(state.acceptTerminalReceipt(terminal("sent", 2L).put("conversation_id", "session-1")));

        MoaVoiceDraftSessionState.TerminalReceipt sent = state.acceptTerminalReceipt(terminal("sent", 2L));
        assertNotNull(sent);
        assertEquals("sent", sent.state);
        assertEquals(2L, sent.authority.revision);

        MoaVoiceDraftSessionState discardedState = readyState();
        assertTrue(discardedState.requestControl(MoaVoiceDraftSessionState.Action.DISCARD, "discard-stable"));
        assertNotNull(discardedState.reserveControlToSend());
        MoaVoiceDraftSessionState.TerminalReceipt discarded = discardedState.acceptTerminalReceipt(
                terminal("discarded", 2L)
        );
        assertNotNull(discarded);
        assertEquals("discarded", discarded.state);
    }

    @Test
    public void networkReceiptsRejectWhitespaceControlPathLikeAndOverlongAuthority() throws Exception {
        MoaVoiceDraftSessionState state = readyState();
        assertTrue(state.requestCommit());
        assertNotNull(state.reserveCommitAuthority());

        String[] hostile = {
                " draft-1",
                "draft-1 ",
                "draft\n1",
                "../draft-1",
                "draft/1",
                "d".repeat(121)
        };
        for (String token : hostile) {
            JSONObject nestedDraft = terminal("sent", 2L);
            nestedDraft.getJSONObject("draft").put("id", token);
            assertNull(state.acceptTerminalReceipt(nestedDraft));

            JSONObject nestedSession = terminal("sent", 2L);
            nestedSession.getJSONObject("draft").put("session_id", token);
            assertNull(state.acceptTerminalReceipt(nestedSession));

            JSONObject nestedBranch = terminal("sent", 2L);
            nestedBranch.getJSONObject("draft").put("branch_id", token);
            assertNull(state.acceptTerminalReceipt(nestedBranch));

            assertNull(state.acceptTerminalReceipt(terminal("sent", 2L).put("session_id", token)));
            assertNull(state.acceptTerminalReceipt(terminal("sent", 2L).put("branch_id", token)));
        }

        assertNotNull(state.acceptTerminalReceipt(terminal("sent", 2L)));
    }

    private static MoaVoiceDraftSessionState freshState() {
        return new MoaVoiceDraftSessionState("session-1", "branch-1", "turn-1", null);
    }

    private static MoaVoiceDraftSessionState readyState() throws Exception {
        MoaVoiceDraftSessionState state = freshState();
        assertTrue(state.bindReady(ready("create", "draft-1", 1L)));
        state.markTransportReady();
        return state;
    }

    private static MoaVoiceDraftPointer pointer(String draftId, long revision) {
        return new MoaVoiceDraftPointer(draftId, revision, "session-1", "branch-1");
    }

    private static JSONObject ready(String action, String draftId, long revision) throws Exception {
        return envelope("voice_draft_ready", draftId, revision, "capturing")
                .put("action", action);
    }

    private static JSONObject ack(
            String type,
            String action,
            String draftId,
            long revision,
            String draftState
    ) throws Exception {
        return envelope(type, draftId, revision, draftState).put("action", action);
    }

    private static JSONObject terminal(String state, long revision) throws Exception {
        return envelope("turn_done", "draft-1", revision, state).put("status", "completed");
    }

    private static JSONObject envelope(String type, String draftId, long revision, String draftState) throws Exception {
        return new JSONObject()
                .put("type", type)
                .put("session_id", "session-1")
                .put("branch_id", "branch-1")
                .put("turn_id", "turn-1")
                .put("draft", draft(draftId, revision, draftState));
    }

    private static JSONObject draft(String id, long revision, String state) throws Exception {
        return new JSONObject()
                .put("id", id)
                .put("revision", revision)
                .put("state", state)
                .put("session_id", "session-1")
                .put("branch_id", "branch-1");
    }
}

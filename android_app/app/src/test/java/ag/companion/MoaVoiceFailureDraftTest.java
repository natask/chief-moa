package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaVoiceFailureDraftTest {
    @Test
    public void latestUsablePartialSurvivesFailureAsEditableText() {
        MoaVoiceFailureDraft draft = new MoaVoiceFailureDraft();
        draft.begin("turn_original");
        draft.observe("add release");
        draft.observe("add release rescue");

        MoaVoiceFailureDraft.Snapshot failed = draft.fail(
                "turn_original", "", "socket closed");

        assertEquals("add release rescue", failed.text);
        assertEquals("turn_original", failed.requestId);
        assertTrue(draft.hasFailedDraft());
    }

    @Test
    public void voiceRetryAndEditedTextSubmitShareOneIdentity() {
        MoaVoiceFailureDraft draft = new MoaVoiceFailureDraft();
        draft.begin("turn_idempotent");
        MoaVoiceFailureDraft.Snapshot failed = draft.fail(
                "turn_idempotent", "fix voice", "gateway rejected token");

        String voiceRetryIdentity = failed.requestId;
        String textSubmitIdentity = draft.snapshot().requestId;
        draft.begin(voiceRetryIdentity);

        assertEquals("turn_idempotent", voiceRetryIdentity);
        assertEquals(voiceRetryIdentity, textSubmitIdentity);
        assertEquals("fix voice", draft.snapshot().text);
        draft.armTextSubmit(textSubmitIdentity);
        assertEquals(voiceRetryIdentity, draft.nextTextTurnId());
        assertFalse(voiceRetryIdentity.equals(draft.nextTextTurnId()));
    }

    @Test
    public void reconnectIsReservedForAuthenticationFailures() {
        assertTrue(MoaVoiceFailureDraft.isAuthenticationFailure(
                "model gateway token required"));
        assertTrue(MoaVoiceFailureDraft.isAuthenticationFailure("HTTP 401 unauthorized"));
        assertFalse(MoaVoiceFailureDraft.isAuthenticationFailure("socket timed out"));
        assertTrue(MoaVoiceFailureDraft.shortNotice("model gateway token required")
                .contains("rejected this device's token"));
    }

    @Test
    public void recoveryActionsStayDistinctAndExplicit() {
        assertEquals("Send as text", MoaVoiceFailureDraft.SEND_AS_TEXT);
        assertEquals("Try voice again", MoaVoiceFailureDraft.TRY_VOICE_AGAIN);
        assertEquals("Reconnect device", MoaVoiceFailureDraft.RECONNECT_DEVICE);
        assertEquals("Open release rescue", MoaVoiceFailureDraft.OPEN_RELEASE_RESCUE);
    }
}

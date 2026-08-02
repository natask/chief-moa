package ag.companion;

import org.json.JSONObject;

/** Exact-identity and monotonicity gate for gateway-owned transcript corrections. */
final class MoaTranscriptRevisionGate {
    private final String sessionId;
    private final String branchId;
    private final String turnId;
    private long transcriptSequence;
    private long correctionRevision;
    private boolean capturing = true;

    MoaTranscriptRevisionGate(String sessionId, String branchId, String turnId) {
        this.sessionId = safe(sessionId);
        this.branchId = normalizedBranch(branchId);
        this.turnId = safe(turnId);
    }

    Snapshot acceptProviderSnapshot(String eventTurnId, String text, long sequence, boolean isFinal) {
        if (!turnId.equals(safe(eventTurnId)) || safe(text).isEmpty()) return null;
        if (sequence > 0L) {
            if (sequence <= transcriptSequence) return null;
            transcriptSequence = sequence;
        } else if (transcriptSequence > 0L) {
            // Once the gateway advertises ordered snapshots, an unsequenced
            // late event can no longer overwrite them.
            return null;
        }
        if (isFinal) capturing = false;
        return new Snapshot(text, sequence, correctionRevision, isFinal, false);
    }

    Snapshot acceptPrefixRevision(JSONObject event) {
        if (!capturing || !exactUserIdentity(event, "transcript_prefix_revision")) return null;
        if (!event.has("finalized_text") || !event.has("unsealed_text") || !event.has("text")) return null;
        long sequence = integralPositive(event, "transcript_sequence");
        long revision = integralPositive(event, "revision");
        long sealedAudioByte = integralNonNegative(event, "sealed_through_audio_byte");
        String text = event.optString("text", "");
        if (sequence <= transcriptSequence || revision <= correctionRevision
                || sealedAudioByte < 0L || safe(text).isEmpty()) return null;
        transcriptSequence = sequence;
        correctionRevision = revision;
        return new Snapshot(text, sequence, revision, false, true);
    }

    Snapshot acceptCompletedRevision(JSONObject event) {
        if (capturing || !exactUserIdentity(event, "transcript_revision")) return null;
        long revision = integralPositive(event, "revision");
        String text = event.optString("text", "");
        if (revision <= correctionRevision || safe(text).isEmpty()) return null;
        correctionRevision = revision;
        return new Snapshot(text, transcriptSequence, revision, true, true);
    }

    static Snapshot acceptCompletedMessage(JSONObject event, ChatMessage message,
            String activeSessionId, String activeBranchId, String activeTurnId) {
        if (event == null || message == null || message.assistant || message.notice
                || !message.finalizedUserTranscript
                || !"transcript_revision".equals(safe(event.optString("type", "")))
                || !"user".equals(safe(event.optString("speaker", "")))) return null;
        String eventSession = safe(event.optString("session_id", ""));
        String eventBranch = normalizedBranch(event.optString("branch_id", ""));
        String eventTurn = safe(event.optString("turn_id", ""));
        String expectedMessageId = "turn:" + eventSession + ":" + eventBranch + ":" + eventTurn + ":user";
        boolean targetsActiveCapture = eventSession.equals(safe(activeSessionId))
                && eventBranch.equals(normalizedBranch(activeBranchId))
                && eventTurn.equals(safe(activeTurnId));
        long revision = integralPositive(event, "revision");
        String text = event.optString("text", "");
        if (targetsActiveCapture || !message.sessionId.equals(eventSession)
                || !message.branchId.equals(eventBranch) || !message.turnId.equals(eventTurn)
                || !expectedMessageId.equals(safe(event.optString("message_id", "")))
                || revision <= message.transcriptRevision || safe(text).isEmpty()) return null;
        return new Snapshot(text, -1L, revision, true, true);
    }

    private boolean exactUserIdentity(JSONObject event, String expectedType) {
        return event != null
                && expectedType.equals(safe(event.optString("type", "")))
                && "user".equals(safe(event.optString("speaker", "")))
                && sessionId.equals(safe(event.optString("session_id", "")))
                && branchId.equals(normalizedBranch(event.optString("branch_id", "")))
                && turnId.equals(safe(event.optString("turn_id", "")));
    }

    private static long integralPositive(JSONObject event, String key) {
        Object value = event == null ? null : event.opt(key);
        if (!(value instanceof Number)) return -1L;
        double number = ((Number) value).doubleValue();
        long integer = ((Number) value).longValue();
        return Double.isFinite(number) && number == integer && integer > 0L ? integer : -1L;
    }

    private static long integralNonNegative(JSONObject event, String key) {
        Object value = event == null ? null : event.opt(key);
        if (!(value instanceof Number)) return -1L;
        double number = ((Number) value).doubleValue();
        long integer = ((Number) value).longValue();
        return Double.isFinite(number) && number == integer && integer >= 0L ? integer : -1L;
    }

    private static String normalizedBranch(String value) {
        String branch = safe(value);
        return branch.isEmpty() ? "default" : branch;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    static final class Snapshot {
        final String text;
        final long transcriptSequence;
        final long correctionRevision;
        final boolean finalized;
        final boolean corrected;

        Snapshot(String text, long transcriptSequence, long correctionRevision,
                boolean finalized, boolean corrected) {
            this.text = text;
            this.transcriptSequence = transcriptSequence;
            this.correctionRevision = correctionRevision;
            this.finalized = finalized;
            this.corrected = corrected;
        }
    }
}

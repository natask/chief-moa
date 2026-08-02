package ag.companion;

final class ChatMessage {
    final boolean assistant;
    final String text;
    // A notice is a status/error line (for example a dropped voice turn). It
    // renders as a distinct muted-ember inline strip, never a fake Ag bubble.
    final boolean notice;
    final String sessionId;
    final String branchId;
    final String turnId;
    final long transcriptRevision;
    final boolean finalizedUserTranscript;

    ChatMessage(boolean assistant, String text) {
        this(assistant, text, false);
    }

    ChatMessage(boolean assistant, String text, boolean notice) {
        this(assistant, text, notice, "", "", "", -1L, false);
    }

    ChatMessage(boolean assistant, String text, boolean notice, String sessionId,
            String branchId, String turnId, long transcriptRevision,
            boolean finalizedUserTranscript) {
        this.assistant = assistant;
        this.text = text;
        this.notice = notice;
        this.sessionId = safe(sessionId);
        this.branchId = safe(branchId).isEmpty() ? "default" : safe(branchId);
        this.turnId = safe(turnId);
        this.transcriptRevision = transcriptRevision;
        this.finalizedUserTranscript = finalizedUserTranscript;
    }

    ChatMessage correctedTranscript(String replacement, long revision) {
        return new ChatMessage(false, replacement, false, sessionId, branchId,
                turnId, revision, true);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

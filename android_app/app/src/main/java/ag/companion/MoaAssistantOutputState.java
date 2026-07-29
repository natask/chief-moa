package ag.companion;

/** Pure turn-scoped admission state for assistant text and speech delivery. */
final class MoaAssistantOutputState {
    private String turnId = "";
    private boolean speechSuppressed = true;

    void begin(String nextTurnId) {
        turnId = safe(nextTurnId);
        speechSuppressed = turnId.isEmpty();
    }

    void suppressSpeech() {
        speechSuppressed = true;
    }

    boolean allowsText(String candidateTurnId) {
        return matches(candidateTurnId);
    }

    boolean allowsSpeech(String candidateTurnId) {
        return !speechSuppressed && matches(candidateTurnId);
    }

    private boolean matches(String candidateTurnId) {
        return !turnId.isEmpty() && turnId.equals(safe(candidateTurnId));
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

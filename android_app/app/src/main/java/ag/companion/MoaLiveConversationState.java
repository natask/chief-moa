package ag.companion;

/** Pure, turn-scoped presentation state for the two live conversation ribbons. */
final class MoaLiveConversationState {
    private String turnId = "";
    private String userText = "";
    private int userUnstableStart;
    private boolean userListening;
    private boolean userFinal;
    private String assistantFullText = "";
    private String assistantSpokenText = "";
    private int assistantSpokenChars;
    private boolean assistantPending;
    private boolean assistantPlayback;

    void begin(String nextTurnId) {
        turnId = safe(nextTurnId);
        userText = "";
        userUnstableStart = 0;
        userListening = !turnId.isEmpty();
        userFinal = false;
        assistantFullText = "";
        assistantSpokenText = "";
        assistantSpokenChars = 0;
        assistantPending = false;
        assistantPlayback = false;
    }

    boolean updateUserPartial(String candidateTurnId, String text) {
        if (!matches(candidateTurnId) || userFinal) return false;
        userText = safe(text);
        userUnstableStart = newestTokenStart(userText);
        return true;
    }

    boolean finalizeUser(String candidateTurnId, String text) {
        if (!matches(candidateTurnId)) return false;
        userText = safe(text);
        userUnstableStart = userText.length();
        userListening = false;
        userFinal = true;
        assistantPending = !userText.isEmpty();
        return true;
    }

    boolean awaitAssistant(String candidateTurnId) {
        if (!matches(candidateTurnId)) return false;
        userListening = false;
        userUnstableStart = userText.length();
        assistantPending = true;
        return true;
    }

    boolean setAssistantFullText(String candidateTurnId, String text) {
        if (!matches(candidateTurnId)) return false;
        assistantFullText = safe(text);
        assistantPending = true;
        return true;
    }

    boolean startAssistantPlayback(String candidateTurnId) {
        if (!matches(candidateTurnId)) return false;
        assistantPending = true;
        assistantPlayback = true;
        assistantSpokenChars = 0;
        return true;
    }

    boolean advanceAssistantPlayback(String candidateTurnId, String spokenText, int chars) {
        if (!matches(candidateTurnId) || !assistantPlayback) return false;
        String ledgerText = safe(spokenText);
        if (!ledgerText.isEmpty()) assistantSpokenText = ledgerText;
        int limit = assistantSpokenText.length();
        assistantSpokenChars = Math.max(assistantSpokenChars, clamp(chars, 0, limit));
        return true;
    }

    boolean finishAssistantPlayback(String candidateTurnId, String spokenText) {
        if (!matches(candidateTurnId)) return false;
        String ledgerText = safe(spokenText);
        if (!ledgerText.isEmpty()) assistantSpokenText = ledgerText;
        assistantSpokenChars = assistantSpokenText.length();
        assistantPlayback = false;
        assistantPending = false;
        return true;
    }

    void clear() { begin(""); }

    String userText() { return userText; }
    int userUnstableStart() { return userUnstableStart; }
    boolean userPlaceholder() { return userListening && userText.isEmpty(); }
    boolean userListening() { return userListening; }
    String assistantFullText() { return assistantFullText; }
    String assistantCollapsedText() {
        if (assistantPending && !assistantPlayback) return "";
        if (!assistantPlayback) return assistantFullText;
        String source = assistantSpokenText;
        return source.substring(0, Math.min(assistantSpokenChars, source.length()));
    }
    boolean assistantPlaceholder() {
        return assistantPending && assistantCollapsedText().isEmpty();
    }
    boolean assistantCaret() { return assistantPending || assistantPlayback; }

    private boolean matches(String candidate) {
        return !turnId.isEmpty() && turnId.equals(safe(candidate));
    }

    static int newestTokenStart(String text) {
        String value = safe(text);
        int i = value.length();
        while (i > 0 && !Character.isWhitespace(value.charAt(i - 1))) i--;
        return i;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

package ai.moa.assistant;

/** Exact, deterministic clipboard representation of one retained history turn. */
final class MoaHistoryCopyText {
    private MoaHistoryCopyText() {}

    static String compose(String userText, String assistantText) {
        String user = userText == null ? "" : userText;
        String assistant = assistantText == null ? "" : assistantText;
        if (user.isEmpty()) return assistant;
        if (assistant.isEmpty()) return user;
        return user + "\n\n" + assistant;
    }
}

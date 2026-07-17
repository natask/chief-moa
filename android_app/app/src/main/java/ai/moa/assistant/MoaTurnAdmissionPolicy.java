package ai.moa.assistant;

/** Prevents empty or punctuation-only capture artifacts from becoming turns or agent runs. */
final class MoaTurnAdmissionPolicy {
    private MoaTurnAdmissionPolicy() {}

    static boolean hasUserText(String text) {
        if (text == null) return false;
        for (int offset = 0; offset < text.length();) {
            int codePoint = text.codePointAt(offset);
            if (Character.isLetterOrDigit(codePoint)) return true;
            offset += Character.charCount(codePoint);
        }
        return false;
    }
}

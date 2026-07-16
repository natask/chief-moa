package ai.moa.assistant;

import java.util.List;

/** Pure selection policy: preserve the first recognizer transcript exactly. */
final class MoaLiteralTranscriptPolicy {
    private MoaLiteralTranscriptPolicy() {
    }

    static String firstLiteral(List<String> alternatives) {
        if (alternatives == null) {
            return null;
        }
        for (String alternative : alternatives) {
            if (alternative != null && !alternative.isEmpty()) {
                return alternative;
            }
        }
        return null;
    }
}

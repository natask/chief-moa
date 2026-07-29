package ai.moa.assistant;

/** Pure layout policy for the compact voice transcript overlay. */
final class MoaTranscriptViewport {
    static final int COLLAPSED_LINES = 1;
    static final int EXPANDED_LINES = 5;

    private MoaTranscriptViewport() {
    }

    static int maxLines(boolean expanded) {
        return expanded ? EXPANDED_LINES : COLLAPSED_LINES;
    }

    static int bodyHeightDp(boolean expanded) {
        return expanded ? 176 : 68;
    }
}

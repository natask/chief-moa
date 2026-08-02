package ag.companion;

/** Exact, deterministic clipboard representation of one retained history message. */
final class MoaHistoryCopyText {
    private MoaHistoryCopyText() {}

    static String exact(String messageText) {
        return messageText == null ? "" : messageText;
    }
}

package ai.moa.assistant;

final class ChatMessage {
    final boolean assistant;
    final String text;
    // A notice is a status/error line (for example a dropped voice turn). It
    // renders as a distinct muted-ember inline strip, never a fake A.G. bubble.
    final boolean notice;

    ChatMessage(boolean assistant, String text) {
        this(assistant, text, false);
    }

    ChatMessage(boolean assistant, String text, boolean notice) {
        this.assistant = assistant;
        this.text = text;
        this.notice = notice;
    }
}

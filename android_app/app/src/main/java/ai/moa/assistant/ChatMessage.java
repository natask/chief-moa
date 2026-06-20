package ai.moa.assistant;

final class ChatMessage {
    final boolean assistant;
    final String text;

    ChatMessage(boolean assistant, String text) {
        this.assistant = assistant;
        this.text = text;
    }
}

package ai.moa.assistant;

final class MoaStrings {
    private MoaStrings() {
    }

    static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    static String cleanError(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            message = error.getClass().getSimpleName();
        }
        message = message.replace('\n', ' ').replace('\r', ' ').trim();
        if (message.length() > 180) {
            return message.substring(0, 180);
        }
        return message;
    }
}

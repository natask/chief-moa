package ai.moa.assistant;

import java.util.Locale;

final class MoaOperationalTurnRouter {
    private MoaOperationalTurnRouter() {
    }

    static String agentPromptFrom(String text) {
        String trimmed = safe(text);
        String lower = trimmed.toLowerCase(Locale.US);
        String[] prefixes = new String[]{"/agent ", "/run ", "agent run ", "moa run "};
        for (String prefix : prefixes) {
            if (lower.startsWith(prefix)) {
                return trimmed.substring(prefix.length()).trim();
            }
        }
        return "";
    }

    static boolean shouldRunAgentFromVoice(String text, boolean fromVoice) {
        if (!fromVoice) {
            return false;
        }
        String lower = normalizeSpeech(text);
        if (lower.isEmpty()) {
            return false;
        }

        String[] actionStarts = new String[]{
                "make ",
                "build ",
                "fix ",
                "change ",
                "implement ",
                "add ",
                "update ",
                "refactor ",
                "test ",
                "create ",
                "wire ",
                "hook up ",
                "continue ",
                "make progress "
        };
        for (String start : actionStarts) {
            if (lower.startsWith(start.trim() + " ")) {
                return true;
            }
        }
        return lower.contains("push code")
                || lower.contains("make it work")
                || lower.contains("run the tests")
                || lower.contains("home machine")
                || lower.contains("in the repo")
                || lower.contains("in the app");
    }

    static boolean shouldRouteThroughMoa(String text) {
        String lower = normalizeSpeech(text);
        if (lower.isEmpty()) {
            return false;
        }
        return shouldRunAgentFromVoice(text, true)
                || !agentPromptFrom(text).isEmpty()
                || lower.contains("operational")
                || lower.contains("operating")
                || lower.contains("what s going on")
                || lower.contains("what is going on")
                || lower.contains("what are all the things")
                || lower.contains("projects i have ongoing")
                || lower.contains("all the projects")
                || lower.contains("what am i working on")
                || lower.contains("forward progress")
                || lower.contains("chrome extension")
                || lower.contains("android app")
                || lower.contains("mobile gateway")
                || lower.contains("moa gateway");
    }

    static boolean shouldForceAgent(String text) {
        String lower = normalizeSpeech(text);
        return shouldRunAgentFromVoice(text, true)
                || !agentPromptFrom(text).isEmpty()
                || lower.contains("operational")
                || lower.contains("operating")
                || lower.contains("what s going on")
                || lower.contains("what is going on")
                || lower.contains("projects i have ongoing")
                || lower.contains("all the projects")
                || lower.contains("what am i working on")
                || lower.contains("forward progress")
                || lower.contains("chrome extension")
                || lower.contains("android app")
                || lower.contains("mobile gateway")
                || lower.contains("moa gateway");
    }

    static String normalizeSpeech(String value) {
        return safe(value)
                .toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9 ]", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

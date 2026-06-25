package ai.moa.assistant;

import java.util.Locale;

final class MoaOperationalTurnRouter {
    private static final String[] PROFILE_LANGUAGE_NAMES = new String[]{
            "english",
            "spanish",
            "french",
            "german",
            "italian",
            "portuguese",
            "dutch",
            "russian",
            "polish",
            "ukrainian",
            "turkish",
            "arabic",
            "hebrew",
            "hindi",
            "bengali",
            "bangla",
            "urdu",
            "tamil",
            "telugu",
            "mandarin",
            "chinese",
            "cantonese",
            "japanese",
            "korean",
            "vietnamese",
            "thai",
            "indonesian",
            "malay",
            "filipino",
            "tagalog",
            "swahili",
            "amharic",
            "tigrinya",
            "tigrigna",
            "somali",
            "hausa",
            "yoruba",
            "igbo",
            "zulu",
            "afrikaans",
            "greek",
            "czech",
            "romanian",
            "hungarian",
            "swedish",
            "norwegian",
            "danish",
            "finnish",
            "persian",
            "farsi"
    };

    private static final String[] PROFILE_VOICE_NAMES = new String[]{
            "puck",
            "charon",
            "kore",
            "fenrir",
            "aoede",
            "leda",
            "orus",
            "zephyr"
    };

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
        if (isProfileControlIntent(text)) {
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
                || isProfileControlIntent(text)
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

    static boolean isProfileControlIntent(String text) {
        String lower = normalizeSpeech(text);
        if (lower.isEmpty()) {
            return false;
        }
        return isPromptControlIntent(lower)
                || isIdentityControlIntent(lower)
                || isLanguageControlIntent(lower)
                || isVoiceControlIntent(lower);
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

    private static boolean isPromptControlIntent(String lower) {
        return lower.contains("what prompt")
                || lower.contains("which prompt")
                || lower.contains("current prompt")
                || lower.matches(".*\\b(set|change|update)\\b.*\\b(system )?prompt\\b.*");
    }

    private static boolean isIdentityControlIntent(String lower) {
        return lower.contains("what is your name")
                || lower.contains("what s your name")
                || lower.contains("who are you")
                || lower.matches(".*\\byour name\\b\\s*(is|should be|will be).*")
                || lower.matches(".*\\b(call|name) yourself\\b.*")
                || lower.matches(".*\\b(you are|youre)\\b\\s+(now\\s+)?(called\\s+|named\\s+)?.*");
    }

    private static boolean isLanguageControlIntent(String lower) {
        if (lower.contains("what language")
                || lower.contains("which language")
                || lower.contains("language is active")
                || lower.matches(".*\\b(set|change|update|switch)\\b.*\\blanguage\\b.*")) {
            return true;
        }
        if (!containsAny(lower, PROFILE_LANGUAGE_NAMES)) {
            return false;
        }
        return lower.matches(".*\\b(speak|talk|reply|respond|answer|say|process|understand|listen|recognize|restrict|select|allow)\\b.*")
                || lower.contains(" only ")
                || lower.startsWith("only ")
                || lower.contains("do not switch")
                || lower.contains("don t switch")
                || lower.contains("dont switch")
                || lower.contains("these languages")
                || lower.contains("these two languages");
    }

    private static boolean isVoiceControlIntent(String lower) {
        if (isVoiceSamplerIntent(lower)) {
            return true;
        }
        if (lower.contains("what voice")
                || lower.contains("what voices")
                || lower.contains("which voice")
                || lower.contains("which voices")
                || lower.matches(".*\\b(set|change|switch|use|make)\\b.*\\bvoices?\\b.*")) {
            return true;
        }
        if (lower.contains("sound like") || lower.contains("speak like")) {
            return lower.contains("female")
                    || lower.contains("woman")
                    || lower.contains("girl")
                    || lower.contains("feminine")
                    || lower.contains("lady")
                    || lower.contains("male")
                    || lower.contains("man")
                    || lower.contains("guy")
                    || lower.contains("masculine")
                    || lower.contains("boy")
                    || containsAny(lower, PROFILE_VOICE_NAMES);
        }
        return containsAny(lower, PROFILE_VOICE_NAMES)
                && lower.matches(".*\\b(use|switch|set|change)\\b.*");
    }

    private static boolean isVoiceSamplerIntent(String lower) {
        if (!lower.matches(".*\\bvoices?\\b.*")) {
            return false;
        }
        if (lower.matches(".*\\b(sample|samples|sampling|test|try|preview|demo|demonstrate|audition|hear)\\b.*\\bvoices?\\b.*")) {
            return true;
        }
        if (lower.matches(".*\\b(go|run|walk|cycle)\\s+through\\b.*\\bvoices?\\b.*")) {
            return true;
        }
        if (lower.matches(".*\\b(say|speak|read|play)\\b.*\\b(in|with)\\s+(all|every|each)\\s+(of\\s+the\\s+)?voices?\\b.*")) {
            return true;
        }
        if (lower.matches(".*\\b(all|every|each)\\s+(of\\s+the\\s+)?voices?\\b.*")
                && lower.matches(".*\\b(say|speak|read|play|sample|test|try|preview|demo|go|run|walk|cycle|change|switch)\\b.*")) {
            return true;
        }
        return lower.matches(".*\\bvoices?\\b.*\\b(one\\s+after\\s+(the\\s+)?other|one\\s+by\\s+one|in\\s+order|sequentially)\\b.*");
    }

    private static boolean containsAny(String lower, String[] values) {
        for (String value : values) {
            if (lower.contains(value)) {
                return true;
            }
        }
        return false;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

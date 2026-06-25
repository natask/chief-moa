package ai.moa.assistant;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class MoaSpeechTranscriptAccumulator {
    private String transcript = "";

    void reset() {
        transcript = "";
    }

    String snapshot() {
        return transcript;
    }

    String update(String nextText) {
        transcript = merge(transcript, nextText);
        return transcript;
    }

    static String merge(String current, String addition) {
        String left = normalizeSpaces(current);
        String right = normalizeSpaces(addition);
        if (right.isEmpty()) {
            return left;
        }
        if (left.isEmpty()) {
            return right;
        }

        List<Token> leftTokens = tokens(left);
        List<Token> rightTokens = tokens(right);
        if (!leftTokens.isEmpty() && !rightTokens.isEmpty()) {
            if (sameTokens(leftTokens, rightTokens)) {
                return right.length() >= left.length() ? right : left;
            }
            if (startsWithTokens(rightTokens, leftTokens)) {
                return right;
            }
            if (endsWithTokens(leftTokens, rightTokens)) {
                return left;
            }

            int overlap = tokenOverlap(leftTokens, rightTokens);
            if (overlap > 0) {
                if (overlap >= rightTokens.size()) {
                    return left;
                }
                return normalizeSpaces(left + " " + right.substring(rightTokens.get(overlap).start));
            }
        }

        return normalizeSpaces(left + " " + right);
    }

    private static int tokenOverlap(List<Token> left, List<Token> right) {
        int max = Math.min(left.size(), right.size());
        for (int count = max; count > 0; count--) {
            boolean matches = true;
            for (int i = 0; i < count; i++) {
                String a = left.get(left.size() - count + i).normalized;
                String b = right.get(i).normalized;
                if (!a.equals(b)) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                return count;
            }
        }
        return 0;
    }

    private static boolean sameTokens(List<Token> left, List<Token> right) {
        return left.size() == right.size() && startsWithTokens(left, right);
    }

    private static boolean startsWithTokens(List<Token> value, List<Token> prefix) {
        if (prefix.size() > value.size()) {
            return false;
        }
        for (int i = 0; i < prefix.size(); i++) {
            if (!value.get(i).normalized.equals(prefix.get(i).normalized)) {
                return false;
            }
        }
        return true;
    }

    private static boolean endsWithTokens(List<Token> value, List<Token> suffix) {
        if (suffix.size() > value.size()) {
            return false;
        }
        int offset = value.size() - suffix.size();
        for (int i = 0; i < suffix.size(); i++) {
            if (!value.get(offset + i).normalized.equals(suffix.get(i).normalized)) {
                return false;
            }
        }
        return true;
    }

    private static List<Token> tokens(String value) {
        ArrayList<Token> out = new ArrayList<>();
        int start = -1;
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (Character.isLetterOrDigit(ch)) {
                if (start < 0) {
                    start = i;
                }
            } else if (start >= 0) {
                out.add(new Token(value.substring(start, i).toLowerCase(Locale.US), start));
                start = -1;
            }
        }
        if (start >= 0) {
            out.add(new Token(value.substring(start).toLowerCase(Locale.US), start));
        }
        return out;
    }

    private static String normalizeSpaces(String value) {
        return value == null ? "" : value.trim().replaceAll("\\s+", " ");
    }

    private static final class Token {
        final String normalized;
        final int start;

        Token(String normalized, int start) {
            this.normalized = normalized;
            this.start = start;
        }
    }
}

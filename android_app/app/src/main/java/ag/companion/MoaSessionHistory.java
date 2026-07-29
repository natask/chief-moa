package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Bounded, read-only display projection over gateway-owned session messages. */
final class MoaSessionHistory {
    static final int MAX_TURNS = 20;
    static final int MAX_MESSAGES = MAX_TURNS * 2;
    static final int MAX_TEXT_CHARS = 32_768;

    final String sessionId;
    final List<Turn> turns;

    private MoaSessionHistory(String sessionId, List<Turn> turns) {
        this.sessionId = safe(sessionId);
        this.turns = List.copyOf(turns);
    }

    static MoaSessionHistory from(JSONObject payload, String requestedSessionId) {
        String sessionId = firstNonEmpty(
                payload == null ? "" : payload.optString("session_id", ""),
                requestedSessionId);
        JSONArray messages = payload == null ? null : payload.optJSONArray("messages");
        if (messages == null) {
            return new MoaSessionHistory(sessionId, List.of());
        }

        Map<String, TurnBuilder> byTurn = new LinkedHashMap<>();
        Set<String> seenMessageIds = new HashSet<>();
        for (int index = 0; index < messages.length(); index++) {
            JSONObject message = messages.optJSONObject(index);
            if (message == null) {
                continue;
            }
            String messageId = firstNonEmpty(message.optString("message_id", ""), message.optString("id", ""));
            if (!messageId.isEmpty() && !seenMessageIds.add(messageId)) {
                continue;
            }

            String speaker = firstNonEmpty(message.optString("speaker", ""), message.optString("role", ""))
                    .toLowerCase(Locale.US);
            String turnId = message.optString("turn_id", "").trim();
            String branchId = firstNonEmpty(message.optString("branch_id", ""), "default");
            String key = !turnId.isEmpty()
                    ? sessionId + ":" + branchId + ":" + turnId
                    : firstNonEmpty(messageId, "row_" + index);
            TurnBuilder builder = byTurn.get(key);
            if (builder == null) {
                if (byTurn.size() >= MAX_TURNS) {
                    continue;
                }
                builder = new TurnBuilder(key);
                byTurn.put(key, builder);
            }
            builder.acceptMetadata(message, sessionId, branchId, turnId);

            if ("user".equals(speaker) || "assistant".equals(speaker)) {
                String text = bounded(firstText(
                        message.optString("text", ""),
                        message.optString("content", ""),
                        message.optString("message_text", "")));
                if ("user".equals(speaker)) {
                    builder.userText = preferText(builder.userText, text);
                    builder.userMessageId = firstNonEmpty(builder.userMessageId, messageId);
                } else {
                    builder.assistantText = preferText(builder.assistantText, text);
                    builder.assistantMessageId = firstNonEmpty(builder.assistantMessageId, messageId);
                }
                continue;
            }

            // Compatibility shape from GET /v1/history/messages: one record can
            // contain both the retained user text and assistant display text.
            builder.userText = preferText(builder.userText, bounded(message.optString("text", "")));
            builder.assistantText = preferText(
                    builder.assistantText,
                    bounded(firstText(message.optString("assistant_text", ""), message.optString("response_text", ""))));
            builder.userMessageId = firstNonEmpty(builder.userMessageId, messageId);
        }

        List<Turn> turns = new ArrayList<>();
        for (TurnBuilder builder : byTurn.values()) {
            Turn turn = builder.build();
            if (!turn.userText.isEmpty() || !turn.assistantText.isEmpty()) {
                turns.add(turn);
            }
        }
        return new MoaSessionHistory(sessionId, turns);
    }

    static final class Turn {
        final String stableId;
        final String sessionId;
        final String branchId;
        final String turnId;
        final String sourceSurface;
        final String sourceKind;
        final String classification;
        final String completionState;
        final String createdAt;
        final String userText;
        final String assistantText;
        final String userMessageId;
        final String assistantMessageId;
        final boolean textTruncated;

        private Turn(TurnBuilder builder) {
            stableId = builder.stableId;
            sessionId = builder.sessionId;
            branchId = builder.branchId;
            turnId = builder.turnId;
            sourceSurface = builder.sourceSurface;
            sourceKind = builder.sourceKind;
            classification = builder.classification;
            completionState = builder.completionState;
            createdAt = builder.createdAt;
            userText = builder.userText;
            assistantText = builder.assistantText;
            userMessageId = builder.userMessageId;
            assistantMessageId = builder.assistantMessageId;
            textTruncated = builder.textTruncated;
        }

        String metadataLine() {
            List<String> parts = new ArrayList<>();
            parts.add(firstNonEmpty(sourceSurface, "unknown surface"));
            if (!sourceKind.isEmpty()) parts.add(sourceKind);
            if (!classification.isEmpty() && !classification.equals(sourceKind)) parts.add(classification);
            parts.add("branch " + firstNonEmpty(branchId, "default"));
            if (!completionState.isEmpty()) parts.add(completionState);
            if (textTruncated) parts.add("text truncated by gateway");
            return String.join("  ·  ", parts);
        }
    }

    private static final class TurnBuilder {
        final String stableId;
        String sessionId = "";
        String branchId = "default";
        String turnId = "";
        String sourceSurface = "";
        String sourceKind = "";
        String classification = "";
        String completionState = "";
        String createdAt = "";
        String userText = "";
        String assistantText = "";
        String userMessageId = "";
        String assistantMessageId = "";
        boolean textTruncated;

        TurnBuilder(String stableId) {
            this.stableId = stableId;
        }

        void acceptMetadata(JSONObject message, String fallbackSessionId, String fallbackBranchId, String fallbackTurnId) {
            sessionId = firstNonEmpty(sessionId, message.optString("session_id", ""), fallbackSessionId);
            branchId = firstNonEmpty(message.optString("branch_id", ""), branchId, fallbackBranchId, "default");
            turnId = firstNonEmpty(turnId, message.optString("turn_id", ""), fallbackTurnId);
            String rawSource = firstNonEmpty(message.optString("source", ""), message.optString("type", ""));
            sourceSurface = firstNonEmpty(sourceSurface, message.optString("source_surface", ""), surfaceFrom(rawSource));
            sourceKind = firstNonEmpty(sourceKind, message.optString("source_kind", ""), kindFrom(message, rawSource));
            classification = firstNonEmpty(classification, message.optString("classification", ""));
            completionState = firstNonEmpty(
                    completionState,
                    message.optString("completion_state", ""),
                    message.optString("status", ""),
                    message.optJSONObject("completion") == null
                            ? "" : message.optJSONObject("completion").optString("state", ""));
            createdAt = firstNonEmpty(createdAt, message.optString("created_at", ""));
            textTruncated = textTruncated || message.optBoolean("text_truncated", false);
        }

        Turn build() {
            return new Turn(this);
        }
    }

    private static String surfaceFrom(String value) {
        String normalized = safe(value).toLowerCase(Locale.US);
        if (normalized.contains("android")) return "android";
        if (normalized.contains("browser") || normalized.contains("extension")) return "browser";
        return safe(value);
    }

    private static String kindFrom(JSONObject message, String rawSource) {
        String type = firstNonEmpty(message.optString("type", ""), rawSource).toLowerCase(Locale.US);
        return type.contains("voice") ? "voice" : type.contains("chat") || type.contains("text") ? "text" : "";
    }

    private static String bounded(String value) {
        String text = value == null ? "" : value;
        if (text.length() <= MAX_TEXT_CHARS) {
            return text;
        }
        return text.substring(0, MAX_TEXT_CHARS) + "\n\n[display capped]";
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            String candidate = safe(value);
            if (!candidate.isEmpty()) return candidate;
        }
        return "";
    }

    private static String firstText(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value;
        }
        return "";
    }

    private static String preferText(String existing, String candidate) {
        return existing != null && !existing.trim().isEmpty() ? existing : candidate == null ? "" : candidate;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

package ai.moa.assistant;

import org.json.JSONObject;

/** Parsed gateway speech outcome plus a fail-closed hosted-TTS recovery plan. */
final class MoaTtsRecoveryPlan {
    enum Delivery {
        COMPLETE,
        PARTIAL,
        FAILED,
        NOT_REQUESTED,
        UNKNOWN
    }

    final Delivery delivery;
    final int fromTextChar;
    final String text;
    final String error;

    private MoaTtsRecoveryPlan(Delivery delivery, int fromTextChar, String text, String error) {
        this.delivery = delivery;
        this.fromTextChar = fromTextChar;
        this.text = text;
        this.error = error;
    }

    static MoaTtsRecoveryPlan fromTurnDone(JSONObject event, String assistantText) {
        String fullText = safe(assistantText);
        if (event == null || !event.has("tts_delivery")) {
            return new MoaTtsRecoveryPlan(Delivery.UNKNOWN, -1, "", "");
        }
        Delivery delivery = parseDelivery(event.optString("tts_delivery", ""));
        if (delivery != Delivery.PARTIAL && delivery != Delivery.FAILED) {
            return new MoaTtsRecoveryPlan(delivery, -1, "", boundedError(event));
        }

        int from = 0;
        if (delivery == Delivery.PARTIAL) {
            int boundary = exactNonNegativeInt(event, "tts_spoken_text_end");
            int declaredChars = exactNonNegativeInt(event, "tts_reply_text_chars");
            boolean reliable = boundary >= 0
                    && declaredChars == fullText.length()
                    && boundary <= declaredChars;
            if (reliable) {
                from = boundary;
            }
        }
        return new MoaTtsRecoveryPlan(
                delivery,
                from,
                fullText.substring(Math.min(from, fullText.length())),
                boundedError(event));
    }

    boolean shouldRetry() {
        return (delivery == Delivery.PARTIAL || delivery == Delivery.FAILED) && !text.isEmpty();
    }

    private static Delivery parseDelivery(String value) {
        switch (safe(value).trim().toLowerCase(java.util.Locale.US)) {
            case "complete":
                return Delivery.COMPLETE;
            case "partial":
                return Delivery.PARTIAL;
            case "failed":
                return Delivery.FAILED;
            case "not_requested":
                return Delivery.NOT_REQUESTED;
            default:
                return Delivery.UNKNOWN;
        }
    }

    private static int exactNonNegativeInt(JSONObject event, String key) {
        if (event == null || !event.has(key)) {
            return -1;
        }
        Object value = event.opt(key);
        if (!(value instanceof Number)) {
            return -1;
        }
        long parsed = ((Number) value).longValue();
        return parsed < 0L || parsed > Integer.MAX_VALUE ? -1 : (int) parsed;
    }

    private static String boundedError(JSONObject event) {
        String error = event == null ? "" : safe(event.optString("tts_error", "")).trim();
        return error.length() <= 240 ? error : error.substring(0, 240);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}

package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

final class MoaPrefs {
    static final String DEFAULT_GATEWAY_URL = "http://10.147.17.10:8788";

    private static final String PREFS = "moa_prefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    private static final String KEY_GATEWAY_TOKEN = "gateway_token";
    private static final String KEY_CONVERSATION_ID = "conversation_id";
    private static final String KEY_HISTORY_JSON = "history_json";
    private static final String KEY_SPOKEN_REPLIES_ENABLED = "spoken_replies_enabled";
    private static final String KEY_SPOKEN_REPLIES_QUIET_DEFAULT_APPLIED = "spoken_replies_quiet_default_applied";

    private MoaPrefs() {
    }

    static String gatewayUrl(Context context) {
        return prefs(context).getString(KEY_GATEWAY_URL, DEFAULT_GATEWAY_URL);
    }

    static String gatewayToken(Context context) {
        return prefs(context).getString(KEY_GATEWAY_TOKEN, "");
    }

    static void saveGatewayConfig(Context context, String gatewayUrl, String gatewayToken) {
        prefs(context).edit()
                .putString(KEY_GATEWAY_URL, gatewayUrl == null ? "" : gatewayUrl.trim())
                .putString(KEY_GATEWAY_TOKEN, gatewayToken == null ? "" : gatewayToken.trim())
                .apply();
    }

    static boolean spokenRepliesEnabled(Context context) {
        SharedPreferences preferences = prefs(context);
        if (!preferences.getBoolean(KEY_SPOKEN_REPLIES_QUIET_DEFAULT_APPLIED, false)) {
            preferences.edit()
                    .putBoolean(KEY_SPOKEN_REPLIES_ENABLED, false)
                    .putBoolean(KEY_SPOKEN_REPLIES_QUIET_DEFAULT_APPLIED, true)
                    .apply();
            return false;
        }
        return preferences.getBoolean(KEY_SPOKEN_REPLIES_ENABLED, false);
    }

    static void setSpokenRepliesEnabled(Context context, boolean enabled) {
        prefs(context).edit()
                .putBoolean(KEY_SPOKEN_REPLIES_ENABLED, enabled)
                .putBoolean(KEY_SPOKEN_REPLIES_QUIET_DEFAULT_APPLIED, true)
                .apply();
    }

    static String conversationId(Context context) {
        SharedPreferences preferences = prefs(context);
        String id = preferences.getString(KEY_CONVERSATION_ID, "");
        if (id != null && !id.trim().isEmpty()) {
            return id.trim();
        }

        String generated = UUID.randomUUID().toString();
        preferences.edit().putString(KEY_CONVERSATION_ID, generated).apply();
        return generated;
    }

    static void setConversationId(Context context, String conversationId) {
        if (conversationId == null || conversationId.trim().isEmpty()) {
            return;
        }
        prefs(context).edit().putString(KEY_CONVERSATION_ID, conversationId.trim()).apply();
    }

    static String historyJson(Context context) {
        return prefs(context).getString(KEY_HISTORY_JSON, "");
    }

    static void setHistoryJson(Context context, String historyJson) {
        prefs(context).edit().putString(KEY_HISTORY_JSON, historyJson == null ? "" : historyJson).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

}

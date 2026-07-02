package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.Locale;
import java.util.UUID;

final class MoaPrefs {
    static final String DEFAULT_GATEWAY_URL = "http://10.147.17.6:8787";

    private static final String PREFS = "moa_prefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    private static final String KEY_GATEWAY_TOKEN = "gateway_token";
    private static final String KEY_CONVERSATION_ID = "conversation_id";
    private static final String KEY_HISTORY_JSON = "history_json";
    private static final String KEY_SPOKEN_REPLIES_ENABLED = "spoken_replies_enabled";
    private static final String KEY_SPOKEN_REPLIES_QUIET_DEFAULT_APPLIED = "spoken_replies_quiet_default_applied";
    private static final String KEY_AGENT_PROFILE_JSON = "agent_profile_json";

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

    static String agentProfileJson(Context context) {
        return prefs(context).getString(KEY_AGENT_PROFILE_JSON, "");
    }

    static void setAgentProfileJson(Context context, String profileJson) {
        prefs(context).edit().putString(KEY_AGENT_PROFILE_JSON, profileJson == null ? "" : profileJson).apply();
    }

    static String inputLanguageTag(Context context) {
        JSONObject profile = agentProfile(context);
        String tag = firstNonEmpty(
                profile.optString("input_language_primary", ""),
                firstLanguage(profile.optString("input_languages", "")),
                profile.optString("language_primary", ""),
                firstLanguage(profile.optString("language", ""))
        );
        return tag.isEmpty() ? Locale.getDefault().toLanguageTag() : tag;
    }

    static String replyLanguageTag(Context context) {
        JSONObject profile = agentProfile(context);
        String tag = firstNonEmpty(
                profile.optString("language_primary", ""),
                firstLanguage(profile.optString("language", "")),
                profile.optString("input_language_primary", ""),
                firstLanguage(profile.optString("input_languages", ""))
        );
        return tag.isEmpty() ? Locale.US.toLanguageTag() : tag;
    }

    static String languageStatus(Context context) {
        String input = inputLanguageTag(context);
        String reply = replyLanguageTag(context);
        if (input.equalsIgnoreCase(reply)) {
            return "Language " + input;
        }
        return "Hear " + input + " / Reply " + reply;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject agentProfile(Context context) {
        String raw = agentProfileJson(context);
        if (raw == null || raw.trim().isEmpty()) {
            return new JSONObject();
        }
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private static String firstLanguage(String value) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty()) {
            return "";
        }
        String[] parts = raw.split(",");
        for (String part : parts) {
            String item = part.trim();
            if (!item.isEmpty()) {
                return item;
            }
        }
        return "";
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) {
            return "";
        }
        for (String value : values) {
            String item = value == null ? "" : value.trim();
            if (!item.isEmpty()) {
                return item;
            }
        }
        return "";
    }

}

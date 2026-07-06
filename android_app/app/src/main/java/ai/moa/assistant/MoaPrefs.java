package ai.moa.assistant;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.net.URI;
import java.util.Locale;
import java.util.UUID;

final class MoaPrefs {
    static final String HOSTED_GATEWAY_URL = BuildConfig.DEFAULT_GATEWAY_URL;
    static final String ONBOARDING_GATEWAY_URL = HOSTED_GATEWAY_URL;
    static final String DEFAULT_GATEWAY_URL = ONBOARDING_GATEWAY_URL;
    static final String LOCAL_DEV_GATEWAY_URL = "http://10.147.17.6:8787";
    static final String LEGACY_MAIN_GATEWAY_URL = "http://10.147.17.10:8787";

    private static final String[] STALE_DEFAULT_GATEWAY_URLS = new String[] {
            LEGACY_MAIN_GATEWAY_URL,
            "http://10.147.17.10:8788",
            "ws://10.147.17.10:8787/v1/voice/sessions",
            "ws://10.147.17.10:8788/v1/voice/sessions"
    };

    private static final String PREFS = "moa_prefs";
    private static final String KEY_GATEWAY_URL = "gateway_url";
    private static final String KEY_GATEWAY_TOKEN = "gateway_token";
    private static final String KEY_CONVERSATION_ID = "conversation_id";
    private static final String KEY_HISTORY_JSON = "history_json";
    private static final String KEY_SPOKEN_REPLIES_ENABLED = "spoken_replies_enabled";
    // One-time flag that flips the earlier hidden "quiet" default to audible.
    // A device that never touched the checkbox starts speaking hosted replies.
    private static final String KEY_SPOKEN_REPLIES_AUDIBLE_DEFAULT_APPLIED = "spoken_replies_audible_default_applied";
    private static final String KEY_AGENT_PROFILE_JSON = "agent_profile_json";
    private static final String KEY_ACTIVE_COMPANION_JSON = "active_companion_json";
    private static final String KEY_ORB_SCALE_PERCENT = "orb_scale_percent";

    // Orb scale contract shared by the overlay (applies it) and the main app
    // (exposes the slider). Percent of the 96dp base window; clamped 50-150.
    static final int ORB_SCALE_MIN = 50;
    static final int ORB_SCALE_MAX = 150;
    static final int ORB_SCALE_DEFAULT = 70;

    private MoaPrefs() {
    }

    static int orbScalePercent(Context context) {
        int stored = prefs(context).getInt(KEY_ORB_SCALE_PERCENT, ORB_SCALE_DEFAULT);
        return Math.max(ORB_SCALE_MIN, Math.min(ORB_SCALE_MAX, stored));
    }

    static void setOrbScalePercent(Context context, int percent) {
        int clamped = Math.max(ORB_SCALE_MIN, Math.min(ORB_SCALE_MAX, percent));
        prefs(context).edit().putInt(KEY_ORB_SCALE_PERCENT, clamped).apply();
    }

    static String gatewayUrl(Context context) {
        SharedPreferences preferences = prefs(context);
        String stored = preferences.getString(KEY_GATEWAY_URL, null);
        if (stored == null) {
            return DEFAULT_GATEWAY_URL;
        }
        String migrated = gatewayUrlAfterStaleDefaultMigration(stored, preferences.getString(KEY_GATEWAY_TOKEN, ""));
        if (!safe(stored).equals(migrated)) {
            preferences.edit().putString(KEY_GATEWAY_URL, migrated).apply();
        }
        return migrated;
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
        // Spoken replies are ON by default: this is a voice assistant with hosted
        // TTS (there is no local TTS fallback). The one-time migration flips the
        // earlier hidden "quiet" default to audible so devices that never found
        // the checkbox start speaking. Once the user makes an explicit choice via
        // setSpokenRepliesEnabled, that value sticks.
        if (!preferences.getBoolean(KEY_SPOKEN_REPLIES_AUDIBLE_DEFAULT_APPLIED, false)) {
            preferences.edit()
                    .putBoolean(KEY_SPOKEN_REPLIES_ENABLED, true)
                    .putBoolean(KEY_SPOKEN_REPLIES_AUDIBLE_DEFAULT_APPLIED, true)
                    .apply();
            return true;
        }
        return preferences.getBoolean(KEY_SPOKEN_REPLIES_ENABLED, true);
    }

    static void setSpokenRepliesEnabled(Context context, boolean enabled) {
        prefs(context).edit()
                .putBoolean(KEY_SPOKEN_REPLIES_ENABLED, enabled)
                .putBoolean(KEY_SPOKEN_REPLIES_AUDIBLE_DEFAULT_APPLIED, true)
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

    static String activeCompanionJson(Context context) {
        return activeCompanion(context).toString();
    }

    static void setActiveCompanionJson(Context context, String companionJson) {
        JSONObject companion = parseObject(companionJson);
        prefs(context).edit()
                .putString(KEY_ACTIVE_COMPANION_JSON, sanitizeActiveCompanion(companion).toString())
                .apply();
    }

    static String companionName(Context context) {
        return firstNonEmpty(
                activeCompanion(context).optString("name", ""),
                agentProfile(context).optString("assistant_name", ""),
                "A.G."
        );
    }

    static String companionSummary(Context context) {
        return firstNonEmpty(
                activeCompanion(context).optString("summary", ""),
                "Local fallback companion"
        );
    }

    static String companionPalette(Context context) {
        return firstNonEmpty(activeCompanion(context).optString("palette", ""), "default");
    }

    static String companionMotion(Context context) {
        return firstNonEmpty(activeCompanion(context).optString("motion", ""), "idle");
    }

    static String companionStatus(Context context) {
        String name = companionName(context);
        String summary = companionSummary(context);
        if (summary.isEmpty()) {
            return name;
        }
        return name + " / " + summary;
    }

    static String companionCompactStatus(Context context) {
        return companionName(context) + " / " + companionPalette(context) + " " + companionMotion(context);
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

    static String gatewayUrlAfterStaleDefaultMigration(String storedGatewayUrl, String gatewayToken) {
        String stored = safe(storedGatewayUrl);
        if (stored.isEmpty() || !safe(gatewayToken).isEmpty()) {
            return stored;
        }
        return isStaleDefaultGatewayUrl(stored) ? DEFAULT_GATEWAY_URL : stored;
    }

    static GatewayUrlIssue classifyGatewayUrl(String value) {
        String raw = safe(value);
        if (raw.isEmpty()) {
            return GatewayUrlIssue.NONE;
        }
        String lower = raw.toLowerCase(Locale.US);
        if (!lower.startsWith("http://")
                && !lower.startsWith("https://")
                && !lower.startsWith("ws://")
                && !lower.startsWith("wss://")) {
            return GatewayUrlIssue.MISSING_SCHEME;
        }
        try {
            URI uri = new URI(raw);
            boolean httpOrigin = lower.startsWith("http://") || lower.startsWith("https://");
            String host = safe(uri.getHost()).toLowerCase(Locale.US);
            if ("10.147.17.10".equals(host)) {
                return GatewayUrlIssue.STALE_MAIN_MACHINE;
            }
            if ("10.147.17.6".equals(host)) {
                return GatewayUrlIssue.LOCAL_DEV;
            }
            if (httpOrigin && isEndpointPath(uri.getPath())) {
                return GatewayUrlIssue.ENDPOINT_PATH;
            }
        } catch (Exception ignored) {
            return GatewayUrlIssue.MISSING_SCHEME;
        }
        return GatewayUrlIssue.NONE;
    }

    static String gatewayUrlDiagnosticMessage(String value) {
        GatewayUrlIssue issue = classifyGatewayUrl(value);
        switch (issue) {
            case STALE_MAIN_MACHINE:
                return "This points at the old main-machine ZeroTier gateway. Use the stable VPS URL "
                        + ONBOARDING_GATEWAY_URL + " unless you are intentionally testing local dev.";
            case LOCAL_DEV:
                return "This points at the local Mac gateway. Use the stable VPS URL "
                        + ONBOARDING_GATEWAY_URL
                        + " for mobile onboarding, or keep the phone on the same network/VPN for local dev.";
            case MISSING_SCHEME:
                return "Enter the full gateway URL, for example " + ONBOARDING_GATEWAY_URL + ".";
            case ENDPOINT_PATH:
                return "Save only the gateway origin, not an endpoint path.";
            case NONE:
            default:
                return "";
        }
    }

    enum GatewayUrlIssue {
        NONE,
        MISSING_SCHEME,
        ENDPOINT_PATH,
        STALE_MAIN_MACHINE,
        LOCAL_DEV
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean isStaleDefaultGatewayUrl(String value) {
        String normalized = trimTrailingSlashes(safe(value)).toLowerCase(Locale.US);
        for (String staleUrl : STALE_DEFAULT_GATEWAY_URLS) {
            if (normalized.equals(trimTrailingSlashes(staleUrl).toLowerCase(Locale.US))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isEndpointPath(String value) {
        String path = trimTrailingSlashes(safe(value));
        return "/health".equals(path)
                || "/v1/chat".equals(path)
                || "/v1/voice/turns".equals(path)
                || "/v1/voice/sessions".equals(path);
    }

    private static String trimTrailingSlashes(String value) {
        String result = safe(value);
        while (result.length() > 1 && result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    private static JSONObject agentProfile(Context context) {
        String raw = agentProfileJson(context);
        return parseObject(raw);
    }

    private static JSONObject activeCompanion(Context context) {
        JSONObject stored = sanitizeActiveCompanion(parseObject(prefs(context).getString(KEY_ACTIVE_COMPANION_JSON, "")));
        if (hasCompanionIdentity(stored)) {
            return stored;
        }
        return activeCompanionFromProfile(agentProfile(context));
    }

    private static JSONObject activeCompanionFromProfile(JSONObject profile) {
        JSONObject active = profile.optJSONObject("active_companion");
        JSONObject companion = new JSONObject();
        putSafe(companion, "id", firstNonEmpty(
                active == null ? "" : active.optString("id", ""),
                profile.optString("active_companion_id", "")));
        putSafe(companion, "name", firstNonEmpty(
                active == null ? "" : active.optString("name", ""),
                profile.optString("active_companion_name", ""),
                profile.optString("assistant_name", "")));
        putSafe(companion, "source", firstNonEmpty(
                active == null ? "" : active.optString("source", ""),
                profile.optString("active_companion_source", "")));
        putSafe(companion, "version", firstNonEmpty(
                active == null ? "" : active.optString("version", ""),
                profile.optString("active_companion_version", "")));
        return sanitizeActiveCompanion(companion);
    }

    private static JSONObject sanitizeActiveCompanion(JSONObject input) {
        JSONObject sanitized = new JSONObject();
        putSafe(sanitized, "id", input.optString("id", input.optString("companion_id", "")));
        putSafe(sanitized, "name", input.optString("name", input.optString("companion_name", "")));
        putSafe(sanitized, "summary", input.optString("summary", input.optString("companion_summary", "")));
        putSafe(sanitized, "palette", input.optString("palette", ""));
        putSafe(sanitized, "motion", input.optString("motion", ""));
        putSafe(sanitized, "renderer", input.optString("renderer", ""));
        putSafe(sanitized, "source", input.optString("source", ""));
        putSafe(sanitized, "version", input.optString("version", ""));
        return sanitized;
    }

    private static JSONObject parseObject(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return new JSONObject();
        }
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private static boolean hasCompanionIdentity(JSONObject companion) {
        return companion != null
                && (!safe(companion.optString("id", "")).isEmpty()
                || !safe(companion.optString("name", "")).isEmpty());
    }

    private static void putSafe(JSONObject target, String key, String value) {
        String item = safe(value);
        if (item.isEmpty()) {
            return;
        }
        try {
            target.put(key, item);
        } catch (Exception ignored) {
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

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

}

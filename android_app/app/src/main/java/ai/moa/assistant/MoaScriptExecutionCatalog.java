package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** Closed V1 capability catalog for Android surface-local JavaScript programs. */
final class MoaScriptExecutionCatalog {
    static final int VERSION = 1;
    static final String RUNTIME_ID = "android.webview-js.v1";

    static final String OBSERVE = "android.accessibility.observe";
    static final String FIND = "android.accessibility.find";
    static final String CLICK = "android.accessibility.click";
    static final String SET_TEXT = "android.accessibility.set_text";
    static final String SCROLL = "android.accessibility.scroll";
    static final String BACK = "android.accessibility.back";
    static final String HOME = "android.accessibility.home";

    private static final Set<String> IDS = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList(
            OBSERVE, FIND, CLICK, SET_TEXT, SCROLL, BACK, HOME
    )));
    static final Set<String> EFFECT_CLASSES = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList(
            "read", "navigation", "local_mutation", "external_side_effect", "destructive",
            "security_sensitive", "financial", "publishing", "sending"
    )));

    private MoaScriptExecutionCatalog() {}

    static Set<String> ids() { return IDS; }

    static boolean isRead(String capabilityId) {
        return OBSERVE.equals(capabilityId) || FIND.equals(capabilityId);
    }

    static boolean isMutation(String capabilityId) {
        return IDS.contains(capabilityId) && !isRead(capabilityId);
    }

    static String effectClass(String capabilityId) {
        if (OBSERVE.equals(capabilityId) || FIND.equals(capabilityId)) return "read";
        if (SET_TEXT.equals(capabilityId)) return "external_side_effect";
        return "navigation";
    }

    static JSONArray idsJson() {
        JSONArray result = new JSONArray();
        for (String id : IDS) result.put(id);
        return result;
    }

    static JSONObject descriptor() {
        try {
        JSONArray tools = new JSONArray();
        tools.put(tool(OBSERVE, "Observe the current Accessibility window as a bounded redacted node tree.", "read", "none"));
        tools.put(tool(FIND, "Find nodes in the latest fresh Accessibility observation.", "read", "none"));
        tools.put(tool(CLICK, "Click a fresh node handle after package, window and observation revalidation.", "navigation", "implicit_user_command"));
        tools.put(tool(SET_TEXT, "Set text on a fresh editable node; receipt data never contains the value.", "external_side_effect", "explicit_confirm"));
        tools.put(tool(SCROLL, "Scroll a fresh scrollable node forward or backward.", "navigation", "implicit_user_command"));
        tools.put(tool(BACK, "Perform Android's global Back action after binding revalidation.", "navigation", "implicit_user_command"));
        tools.put(tool(HOME, "Perform Android's global Home action after binding revalidation.", "navigation", "implicit_user_command"));
        JSONObject catalog = new JSONObject().put("version", VERSION).put("tools", tools);
        catalog.put("sha256", MoaProgramJson.sha256(MoaProgramJson.canonical(catalog)));
        return new JSONObject()
                .put("runtime_id", RUNTIME_ID)
                .put("language", "javascript")
                .put("bridge_version", 1)
                .put("entrypoint", "main")
                .put("catalog", catalog)
                .put("max_source_bytes", 65536);
        } catch (Exception error) { throw new IllegalStateException("Unable to encode Android runtime catalog", error); }
    }

    static JSONObject advertisement(String deviceId, long issuedAtMs) {
        try {
        JSONObject catalog = descriptor().getJSONObject("catalog");
        return new JSONObject()
                .put("version", 1)
                .put("type", "surface.runtime.advertised")
                .put("advertisement_id", "sra_android_" + issuedAtMs)
                .put("target", new JSONObject().put("surface_type", "android").put("device_id", deviceId))
                .put("runtime", new JSONObject().put("runtime_id", RUNTIME_ID).put("language", "javascript").put("bridge_version", 1).put("entrypoint", "main"))
                .put("catalog", new JSONObject().put("version", VERSION).put("sha256", catalog.getString("sha256")).put("capability_ids", idsJson()))
                .put("limits", new JSONObject().put("source_bytes", 65536).put("wall_ms", 30000).put("memory_bytes", 33554432)
                        .put("tool_calls", 100).put("parallel_calls", 8).put("result_bytes", 65536).put("log_bytes", 32768))
                .put("issued_at", java.time.Instant.ofEpochMilli(issuedAtMs).toString())
                .put("expires_at", java.time.Instant.ofEpochMilli(issuedAtMs + 30_000L).toString());
        } catch (Exception error) { throw new IllegalStateException("Unable to encode Android runtime advertisement", error); }
    }

    static String sha256() { return descriptor().optJSONObject("catalog").optString("sha256", ""); }

    private static JSONObject tool(String name, String description, String effectClass, String approval) {
        try { return new JSONObject()
                .put("name", name)
                .put("description", description)
                .put("input_schema", new JSONObject().put("type", "object"))
                .put("risk", effectClass)
                .put("effect_class", effectClass)
                .put("approval", approval); }
        catch (Exception error) { throw new IllegalStateException("Unable to encode Android runtime tool", error); }
    }

}

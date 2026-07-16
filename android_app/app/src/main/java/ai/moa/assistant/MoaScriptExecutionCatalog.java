package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.TreeSet;

/** Closed V1 capability catalog for Android surface-local JavaScript programs. */
final class MoaScriptExecutionCatalog {
    static final int VERSION = 1;
    static final String RUNTIME_ID = "android.webview-js.v1";

    static final String OBSERVE = "android.accessibility.observe";
    static final String FIND = "android.accessibility.find";
    static final String CLICK = "android.accessibility.click";
    // Legacy adapter identifier only. It is intentionally absent from IDS and the advertised catalog
    // until Android has a local confirmation flow that can authorize text entry.
    static final String SET_TEXT = "android.accessibility.set_text";
    static final String SCROLL = "android.accessibility.scroll";
    static final String BACK = "android.accessibility.back";
    static final String HOME = "android.accessibility.home";

    private static final Set<String> IDS = Collections.unmodifiableSet(new TreeSet<>(Arrays.asList(
            OBSERVE, FIND, CLICK, SCROLL, BACK, HOME
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
        if (CLICK.equals(capabilityId) || SET_TEXT.equals(capabilityId)) return "external_side_effect";
        return "navigation";
    }

    static JSONArray idsJson() {
        JSONArray result = new JSONArray();
        for (String id : IDS) result.put(id);
        return result;
    }

    static JSONObject descriptor() {
        try {
        JSONArray capabilities = new JSONArray();
        capabilities.put(tool(BACK, "Perform Android Back after exact Accessibility state revalidation.", objectSchema(), objectSchema(), "navigation", "implicit_user_command", "non_idempotent", "exclusive_runtime"));
        capabilities.put(tool(CLICK, "Click a bound fresh Accessibility node after exact state revalidation.", nodeInput(false), objectSchema(), "external_side_effect", "implicit_user_command", "non_idempotent", "serialized_resource"));
        capabilities.put(tool(FIND, "Find bounded nodes within the proposal-bound Accessibility observation.", findInput(), nodesOutput(), "read", "none", "read_only", "parallel_read"));
        capabilities.put(tool(HOME, "Perform Android Home after exact Accessibility state revalidation.", objectSchema(), objectSchema(), "navigation", "implicit_user_command", "non_idempotent", "exclusive_runtime"));
        capabilities.put(tool(OBSERVE, "Return the proposal-bound redacted Accessibility observation without rebinding.", objectSchema(), nodesOutput(), "read", "none", "read_only", "parallel_read"));
        capabilities.put(tool(SCROLL, "Scroll a bound fresh Accessibility node after exact state revalidation.", nodeInput(true), objectSchema(), "navigation", "implicit_user_command", "non_idempotent", "serialized_resource"));
        return new JSONObject().put("version", VERSION).put("capabilities", capabilities);
        } catch (Exception error) { throw new IllegalStateException("Unable to encode Android runtime catalog", error); }
    }

    static JSONObject advertisement(String deviceId, long issuedAtMs) {
        try {
        JSONObject catalog = descriptor();
        return new JSONObject()
                .put("version", 1)
                .put("type", "surface.runtime.advertised")
                .put("advertisement_id", "sra_android_" + issuedAtMs)
                .put("target", new JSONObject().put("surface_type", "android").put("device_id", deviceId))
                .put("runtime", new JSONObject().put("runtime_id", RUNTIME_ID).put("language", "javascript").put("bridge_version", 1).put("entrypoint", "main"))
                .put("catalog", new JSONObject().put("version", VERSION).put("sha256", sha256()).put("capability_ids", idsJson()))
                .put("limits", new JSONObject().put("source_bytes", 65536).put("wall_ms", 30000).put("memory_bytes", JSONObject.NULL)
                        .put("tool_calls", 100).put("parallel_calls", 1).put("result_bytes", 65536).put("log_bytes", 32768))
                .put("issued_at", java.time.Instant.ofEpochMilli(issuedAtMs).toString())
                .put("expires_at", java.time.Instant.ofEpochMilli(issuedAtMs + 30_000L).toString());
        } catch (Exception error) { throw new IllegalStateException("Unable to encode Android runtime advertisement", error); }
    }

    static String sha256() { return MoaProgramJson.sha256(MoaProgramJson.canonical(descriptor())); }

    private static JSONObject tool(String id, String description, JSONObject input, JSONObject output, String effectClass,
                                   String approval, String idempotency, String concurrency) {
        try { return new JSONObject()
                .put("capability_id", id)
                .put("description", description)
                .put("input_schema", input)
                .put("output_schema", output)
                .put("effect_class", effectClass)
                .put("approval_class", approval)
                .put("idempotency", idempotency)
                .put("concurrency", concurrency)
                .put("restore_capability_id", JSONObject.NULL); }
        catch (Exception error) { throw new IllegalStateException("Unable to encode Android runtime tool", error); }
    }

    private static JSONObject objectSchema() { try { return new JSONObject().put("type", "object").put("additionalProperties", false); } catch (Exception e) { throw new IllegalStateException(e); } }
    private static JSONObject nodeInput(boolean direction) { try { JSONObject properties = new JSONObject().put("observation_id", stringSchema()).put("observation_digest", digestSchema()).put("node_id", stringSchema()); if (direction) properties.put("direction", new JSONObject().put("type", "string").put("enum", new JSONArray().put("backward").put("forward"))); return new JSONObject().put("type", "object").put("properties", properties).put("required", new JSONArray().put("observation_id").put("observation_digest").put("node_id")).put("additionalProperties", false); } catch (Exception e) { throw new IllegalStateException(e); } }
    private static JSONObject findInput() { try { return new JSONObject().put("type", "object").put("properties", new JSONObject().put("observation_id", stringSchema()).put("observation_digest", digestSchema()).put("query", stringSchema())).put("required", new JSONArray().put("observation_id").put("observation_digest").put("query")).put("additionalProperties", false); } catch (Exception e) { throw new IllegalStateException(e); } }
    private static JSONObject nodesOutput() { try { return new JSONObject().put("type", "object").put("additionalProperties", true); } catch (Exception e) { throw new IllegalStateException(e); } }
    private static JSONObject stringSchema() { try { return new JSONObject().put("type", "string").put("minLength", 1); } catch (Exception e) { throw new IllegalStateException(e); } }
    private static JSONObject digestSchema() { try { return stringSchema().put("pattern", "^[a-f0-9]{64}$"); } catch (Exception e) { throw new IllegalStateException(e); } }

}

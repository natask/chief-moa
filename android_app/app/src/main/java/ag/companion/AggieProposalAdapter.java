package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Fail-closed Android ingress for Aggie N/N-1 action proposals.
 *
 * <p>This class only validates and canonicalizes proposals. It deliberately has
 * no execution, permission, approval, or receipt APIs; those remain separate
 * Android-owned trust-boundary decisions.</p>
 */
final class AggieProposalAdapter {
    static final int CURRENT_VERSION = 2;
    static final int PREVIOUS_VERSION = 1;
    private static final int MAX_ENVELOPE_BYTES = 64 * 1024;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9._:-]{1,160}$");
    private static final Pattern DIGEST = Pattern.compile("^[a-f0-9]{64}$");
    private static final Set<String> MODES = set("text", "voice", "live_voice", "event");
    private static final Set<String> ACTIONS = set("open_url", "open_app", "dial", "browser_task", "page_tweak", "file_export");
    private static final Set<String> APPROVALS = set("none", "confirm", "sensitive");
    private static final Set<String> EXECUTABLE_KEYS = set("script", "javascript", "shell", "command", "css", "code");
    private static final Set<String> SECRET_KEYS = set("api_key", "apikey", "access_token", "refresh_token", "client_secret", "provider_key", "authorization");
    private static final List<String> SECRET_SUFFIXES = Arrays.asList("token", "privatekey", "apikey", "clientsecret", "providerkey", "authorization", "password");
    private static final List<Pattern> CREDENTIAL_VALUES = Arrays.asList(
            Pattern.compile("\\bBearer\\s+[A-Za-z0-9._~+/\\-]{12,}", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b(?:sk|github_pat|ghp|AIza|ya29)[-_A-Za-z0-9.]{12,}\\b"),
            Pattern.compile("[?&](?:code|access_token|refresh_token|api_key)=[^&#\\s]{8,}", Pattern.CASE_INSENSITIVE));

    static Proposal parse(String json) {
        if (json == null || json.getBytes(StandardCharsets.UTF_8).length > MAX_ENVELOPE_BYTES) fail("invalid_envelope");
        try { return parse(new JSONObject(json)); }
        catch (Rejected error) { throw error; }
        catch (Exception error) { throw new Rejected("invalid_json"); }
    }

    static Proposal parse(JSONObject input) {
        if (input == null || input.toString().getBytes(StandardCharsets.UTF_8).length > MAX_ENVELOPE_BYTES) fail("invalid_envelope");
        requireRequiredKeys(input, set("version", "type", "message_id", "session_id", "surface", "timestamp", "payload"));
        rejectDangerous(input, "envelope", 0);
        int version = safeInt(input, "version");
        if (version != CURRENT_VERSION && version != PREVIOUS_VERSION) fail("unsupported_version");
        if (!"action.proposed".equals(input.optString("type", null))) fail("not_a_proposal");
        String messageId = id(input, "message_id");
        String sessionId = id(input, "session_id");
        String timestamp = instant(input, "timestamp");

        JSONObject surface = object(input, "surface");
        requireRequiredKeys(surface, set("id", "kind", "mode", "device_id"));
        id(surface, "id");
        if (!"android".equals(surface.optString("kind", null))) fail("surface_not_android");
        requireEnum(surface, "mode", MODES);
        id(surface, "device_id"); // complete Android authority scope is mandatory

        JSONObject payload = object(input, "payload");
        Set<String> requiredPayload = set("proposal_id", "kind", "approval_class", "expires_at", "preconditions", "params");
        Set<String> payloadKeys = keys(payload);
        if (!payloadKeys.containsAll(requiredPayload)) fail("invalid_payload_shape");
        id(payload, "proposal_id");
        requireEnum(payload, "kind", ACTIONS);
        requireEnum(payload, "approval_class", APPROVALS);
        instant(payload, "expires_at");
        JSONObject preconditions = object(payload, "preconditions");
        if (!preconditions.keys().hasNext()) fail("missing_preconditions");
        object(payload, "params");
        String proposedBy = payload.has("proposed_by") ? id(payload, "proposed_by") : "gateway";
        if (!"gateway".equals(proposedBy)) fail("invalid_provenance");

        JSONObject normalizedPayload = new JSONObject();
        put(normalizedPayload, "proposal_id", payload.opt("proposal_id"));
        put(normalizedPayload, "kind", payload.opt("kind"));
        put(normalizedPayload, "approval_class", payload.opt("approval_class"));
        put(normalizedPayload, "expires_at", payload.opt("expires_at"));
        put(normalizedPayload, "preconditions", copy(preconditions));
        put(normalizedPayload, "params", copy(object(payload, "params")));
        put(normalizedPayload, "proposed_by", proposedBy);
        put(normalizedPayload, "session_id", sessionId);
        JSONObject normalizedSurface = new JSONObject();
        put(normalizedSurface, "id", surface.opt("id")); put(normalizedSurface, "kind", surface.opt("kind"));
        put(normalizedSurface, "mode", surface.opt("mode")); put(normalizedSurface, "device_id", surface.opt("device_id"));
        JSONObject normalized = new JSONObject();
        put(normalized, "version", version); put(normalized, "message_id", messageId);
        put(normalized, "session_id", sessionId); put(normalized, "surface", normalizedSurface);
        put(normalized, "timestamp", timestamp); put(normalized, "payload", normalizedPayload);
        return new Proposal(version, messageId, sessionId, normalizedSurface, normalizedPayload, sha256(stableJson(normalized)));
    }

    static final class Proposal {
        final int version;
        final String messageId;
        final String sessionId;
        private final JSONObject surface;
        private final JSONObject payload;
        final String digest;

        private Proposal(int version, String messageId, String sessionId, JSONObject surface, JSONObject payload, String digest) {
            this.version = version; this.messageId = messageId; this.sessionId = sessionId;
            this.surface = surface; this.payload = payload; this.digest = digest;
        }
        JSONObject surface() { return copy(surface); }
        JSONObject payload() { return copy(payload); }
    }

    static final class Rejected extends IllegalArgumentException {
        final String code;
        Rejected(String code) { super(code); this.code = code; }
    }

    private static void rejectDangerous(Object value, String field, int depth) {
        if (depth > 20) fail("payload_too_deep");
        if (value == null || value == JSONObject.NULL || value instanceof Boolean) return;
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number) || (value instanceof Double || value instanceof Float) && Math.abs(number) > 9_007_199_254_740_991d) fail("unsafe_number");
            if (value instanceof Long || value instanceof Integer) {
                long integer = ((Number) value).longValue();
                if (integer < -9_007_199_254_740_991L || integer > 9_007_199_254_740_991L) fail("unsafe_number");
            }
            return;
        }
        if (value instanceof String) {
            for (Pattern pattern : CREDENTIAL_VALUES) if (pattern.matcher((String) value).find()) fail("credential_payload");
            return;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) rejectDangerous(array.opt(i), field + "[]", depth + 1);
            return;
        }
        if (!(value instanceof JSONObject)) fail("invalid_data");
        JSONObject object = (JSONObject) value;
        for (Iterator<String> it = object.keys(); it.hasNext();) {
            String key = it.next();
            String normalized = key.replaceAll("[^A-Za-z0-9]", "").toLowerCase(Locale.ROOT);
            if (EXECUTABLE_KEYS.contains(normalized)) fail("executable_payload");
            if (SECRET_KEYS.contains(key.toLowerCase(Locale.ROOT)) || SECRET_SUFFIXES.stream().anyMatch(normalized::contains)) fail("credential_payload");
            rejectDangerous(object.opt(key), field + "." + key, depth + 1);
        }
    }

    private static String stableJson(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> names = new ArrayList<>(keys(object));
            Collections.sort(names);
            List<String> entries = new ArrayList<>();
            for (String name : names) entries.add(JSONObject.quote(name) + ":" + stableJson(object.opt(name)));
            return "{" + String.join(",", entries) + "}";
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            List<String> items = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) items.add(stableJson(array.opt(i)));
            return "[" + String.join(",", items) + "]";
        }
        if (value instanceof String) return JSONObject.quote((String) value);
        return String.valueOf(value);
    }

    private static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : bytes) hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return hex.toString();
        } catch (Exception error) { throw new IllegalStateException(error); }
    }

    private static JSONObject object(JSONObject parent, String key) { Object value = parent.opt(key); if (!(value instanceof JSONObject)) fail("invalid_" + key); return (JSONObject) value; }
    private static JSONObject copy(JSONObject value) { try { return new JSONObject(value.toString()); } catch (Exception error) { throw new Rejected("invalid_json"); } }
    private static void put(JSONObject target, String key, Object value) { try { target.put(key, value); } catch (Exception error) { throw new Rejected("invalid_json"); } }
    private static int safeInt(JSONObject value, String key) { Object raw = value.opt(key); if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).intValue()) fail("invalid_" + key); return ((Number) raw).intValue(); }
    private static String id(JSONObject value, String key) { String raw = value.optString(key, null); if (raw == null || !ID.matcher(raw).matches()) fail("invalid_id"); return raw; }
    private static String instant(JSONObject value, String key) { String raw = value.optString(key, null); try { Instant.parse(raw); } catch (DateTimeParseException | NullPointerException error) { fail("invalid_timestamp"); } return raw; }
    private static void requireEnum(JSONObject value, String key, Set<String> allowed) { if (!allowed.contains(value.optString(key, null))) fail("invalid_" + key); }
    private static void requireRequiredKeys(JSONObject value, Set<String> expected) { if (!keys(value).containsAll(expected)) fail("invalid_shape"); }
    private static Set<String> keys(JSONObject value) { Set<String> result = new HashSet<>(); value.keys().forEachRemaining(result::add); return result; }
    private static Set<String> set(String... values) { return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values))); }
    private static void fail(String code) { throw new Rejected(code); }
}

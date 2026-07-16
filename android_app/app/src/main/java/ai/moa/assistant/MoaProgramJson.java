package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;
import org.erdtman.jcs.JsonCanonicalizer;

import java.nio.charset.StandardCharsets;

/** Deterministic JSON and digest helpers shared by the local-program authority boundary. */
final class MoaProgramJson {
    private MoaProgramJson() {}

    static String canonical(Object value) {
        validate(value);
        String json;
        boolean primitive = !(value instanceof JSONObject) && !(value instanceof JSONArray);
        if (value == null || value == JSONObject.NULL) json = "null";
        else if (!primitive) json = value.toString();
        else if (value instanceof String) json = JSONObject.quote((String) value);
        else json = String.valueOf(value); // validate() has already closed the primitive domain.
        try {
            String input = primitive ? "{\"v\":" + json + "}" : json;
            String canonical = new String(new JsonCanonicalizer(input).getEncodedUTF8(), StandardCharsets.UTF_8);
            return primitive ? canonical.substring(canonical.indexOf(':') + 1, canonical.length() - 1) : canonical;
        }
        catch (Exception error) { throw new IllegalArgumentException("invalid_jcs_value", error); }
    }

    static String sha256(String value) {
        return okio.ByteString.encodeUtf8(value).sha256().hex();
    }

    static JSONObject copy(JSONObject input) {
        try { return new JSONObject(input.toString()); }
        catch (Exception error) { throw new IllegalArgumentException("invalid_json", error); }
    }

    private static void validate(Object value) {
        if (value == null || value == JSONObject.NULL || value instanceof Boolean) return;
        if (value instanceof String) { validateUnicode((String) value); return; }
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number) || (Math.rint(number) == number && Math.abs(number) > 9_007_199_254_740_991d)) throw new IllegalArgumentException("invalid_jcs_number");
            return;
        }
        if (value instanceof JSONObject) { java.util.Iterator<String> keys = ((JSONObject) value).keys(); while (keys.hasNext()) { String key = keys.next(); validateUnicode(key); validate(((JSONObject) value).opt(key)); } return; }
        if (value instanceof JSONArray) { JSONArray array = (JSONArray) value; for (int i = 0; i < array.length(); i++) validate(array.opt(i)); return; }
        throw new IllegalArgumentException("unsupported_json_value");
    }

    private static void validateUnicode(String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new IllegalArgumentException("invalid_jcs_unicode");
                }
                index++;
            } else if (Character.isLowSurrogate(current)) {
                throw new IllegalArgumentException("invalid_jcs_unicode");
            }
        }
    }
}

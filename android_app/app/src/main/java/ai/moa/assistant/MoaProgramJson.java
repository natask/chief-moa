package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/** Deterministic JSON and digest helpers shared by the local-program authority boundary. */
final class MoaProgramJson {
    private MoaProgramJson() {}

    static String canonical(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            List<String> entries = new ArrayList<>();
            for (String key : keys) entries.add(JSONObject.quote(key) + ":" + canonical(object.opt(key)));
            return "{" + String.join(",", entries) + "}";
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            List<String> items = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) items.add(canonical(array.opt(i)));
            return "[" + String.join(",", items) + "]";
        }
        if (value instanceof String) return JSONObject.quote((String) value);
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number)) throw new IllegalArgumentException("non_finite_number");
            return value.toString();
        }
        throw new IllegalArgumentException("unsupported_json_value");
    }

    static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte item : digest) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            return result.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    static JSONObject copy(JSONObject input) {
        try { return new JSONObject(input.toString()); }
        catch (Exception error) { throw new IllegalArgumentException("invalid_json", error); }
    }
}

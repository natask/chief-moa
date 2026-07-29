package ag.companion;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/** Parsed and structurally validated bounded Android-local code-mode program. */
final class MoaAndroidIrProgram {
    static final String VERSION = "moa_android_ir_v1";
    static final int MAX_REPEAT = 100;
    static final int MAX_NESTING = 32;
    static final int MAX_PROGRAM_BYTES = 128 * 1024;

    final JSONArray steps;

    private MoaAndroidIrProgram(JSONArray steps) {
        this.steps = steps;
    }

    static MoaAndroidIrProgram parse(JSONObject document) {
        if (document == null) throw invalid("program is required");
        if (document.toString().length() > MAX_PROGRAM_BYTES) throw invalid("program is too large");
        requireKeys(document, set("version", "steps"));
        if (!VERSION.equals(document.optString("version"))) throw invalid("unsupported version");
        JSONArray steps = requireArray(document, "steps");
        validateSteps(steps, 0);
        return new MoaAndroidIrProgram(steps);
    }

    private static void validateSteps(JSONArray steps, int depth) {
        if (depth > MAX_NESTING) throw invalid("program nesting is too deep");
        for (int i = 0; i < steps.length(); i++) {
            JSONObject step = requireObject(steps, i);
            String op = requireString(step, "op");
            switch (op) {
                case "set":
                    requireKeys(step, set("op", "name", "value"));
                    requireString(step, "name");
                    requirePresent(step, "value");
                    break;
                case "sequence":
                    requireKeys(step, set("op", "steps"));
                    validateSteps(requireArray(step, "steps"), depth + 1);
                    break;
                case "if":
                    requireKeys(step, set("op", "condition", "then", "else"));
                    requirePresent(step, "condition");
                    validateSteps(requireArray(step, "then"), depth + 1);
                    if (step.has("else")) validateSteps(requireArray(step, "else"), depth + 1);
                    break;
                case "repeat":
                    requireKeys(step, set("op", "times", "steps"));
                    int times = requireInt(step, "times");
                    if (times < 0 || times > MAX_REPEAT) throw invalid("repeat must be between 0 and " + MAX_REPEAT);
                    validateSteps(requireArray(step, "steps"), depth + 1);
                    break;
                case "try":
                    requireKeys(step, set("op", "steps", "recover"));
                    validateSteps(requireArray(step, "steps"), depth + 1);
                    validateSteps(requireArray(step, "recover"), depth + 1);
                    break;
                case "call":
                    requireKeys(step, set("op", "capability", "arguments", "assign"));
                    requireString(step, "capability");
                    if (step.has("arguments")) requireObject(step, "arguments");
                    if (step.has("assign")) requireString(step, "assign");
                    break;
                case "wait":
                    requireKeys(step, set("op", "millis"));
                    long millis = requireLong(step, "millis");
                    if (millis < 0) throw invalid("wait must not be negative");
                    break;
                case "checkpoint":
                    requireKeys(step, set("op", "name"));
                    requireString(step, "name");
                    break;
                case "return":
                    requireKeys(step, set("op", "value"));
                    requirePresent(step, "value");
                    break;
                default:
                    throw invalid("unknown op: " + op);
            }
        }
    }

    private static void requireKeys(JSONObject object, Set<String> allowed) {
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!allowed.contains(key)) throw invalid("unknown field: " + key);
        }
    }

    private static JSONArray requireArray(JSONObject object, String key) {
        JSONArray value = object.optJSONArray(key);
        if (value == null) throw invalid(key + " must be an array");
        return value;
    }

    private static JSONObject requireObject(JSONObject object, String key) {
        JSONObject value = object.optJSONObject(key);
        if (value == null) throw invalid(key + " must be an object");
        return value;
    }

    private static JSONObject requireObject(JSONArray array, int index) {
        JSONObject value = array.optJSONObject(index);
        if (value == null) throw invalid("step must be an object");
        return value;
    }

    private static String requireString(JSONObject object, String key) {
        Object value = object.opt(key);
        if (!(value instanceof String) || ((String) value).isEmpty()) throw invalid(key + " must be a non-empty string");
        return (String) value;
    }

    private static int requireInt(JSONObject object, String key) {
        Object value = object.opt(key);
        if (!(value instanceof Number)) throw invalid(key + " must be an integer");
        double numeric = ((Number) value).doubleValue();
        if (numeric != Math.rint(numeric)) throw invalid(key + " must be an integer");
        return ((Number) value).intValue();
    }

    private static long requireLong(JSONObject object, String key) {
        Object value = object.opt(key);
        if (!(value instanceof Number)) throw invalid(key + " must be an integer");
        double numeric = ((Number) value).doubleValue();
        if (numeric != Math.rint(numeric)) throw invalid(key + " must be an integer");
        return ((Number) value).longValue();
    }

    private static void requirePresent(JSONObject object, String key) {
        if (!object.has(key)) throw invalid(key + " is required");
    }

    private static Set<String> set(String... values) {
        Set<String> result = new HashSet<>();
        java.util.Collections.addAll(result, values);
        return result;
    }

    private static IllegalArgumentException invalid(String message) {
        return new IllegalArgumentException("Invalid " + VERSION + ": " + message);
    }
}

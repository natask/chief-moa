package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.nio.charset.StandardCharsets;

/** Deterministic bounded interpreter. It cannot access Android except through its injected host. */
final class MoaAndroidIrInterpreter {
    interface Cancellation {
        boolean isCancelled();
    }

    static final class Limits {
        final int maxSteps;
        final long maxWallMillis;
        final int maxDataBytes;

        Limits(int maxSteps, long maxWallMillis, int maxDataBytes) {
            if (maxSteps <= 0 || maxWallMillis < 0 || maxDataBytes <= 0) {
                throw new IllegalArgumentException("limits must be positive");
            }
            this.maxSteps = maxSteps;
            this.maxWallMillis = maxWallMillis;
            this.maxDataBytes = maxDataBytes;
        }
    }

    static final class Result {
        final Object value;
        final int stepsExecuted;

        Result(Object value, int stepsExecuted) {
            this.value = value;
            this.stepsExecuted = stepsExecuted;
        }
    }

    static class ExecutionException extends Exception {
        ExecutionException(String message) { super(message); }
        ExecutionException(String message, Throwable cause) { super(message, cause); }
    }

    private static final class ControlException extends ExecutionException {
        ControlException(String message) { super(message); }
    }

    private final MoaAndroidIrHost host;
    private final Set<String> allowedCapabilities;
    private final Limits limits;
    private final Cancellation cancellation;
    private final Map<String, Object> variables = new HashMap<>();
    private long startedAt;
    private int executed;
    private boolean returned;
    private Object returnValue = JSONObject.NULL;

    MoaAndroidIrInterpreter(MoaAndroidIrHost host, Set<String> allowedCapabilities,
                            Limits limits, Cancellation cancellation) {
        if (host == null || allowedCapabilities == null || limits == null || cancellation == null) {
            throw new IllegalArgumentException("interpreter dependencies are required");
        }
        this.host = host;
        this.allowedCapabilities = Collections.unmodifiableSet(new java.util.HashSet<>(allowedCapabilities));
        this.limits = limits;
        this.cancellation = cancellation;
    }

    Result execute(MoaAndroidIrProgram program) throws ExecutionException {
        startedAt = host.monotonicTimeMillis();
        run(program.steps);
        return new Result(returnValue, executed);
    }

    private void run(JSONArray steps) throws ExecutionException {
        if (steps == null) return;
        for (int i = 0; i < steps.length() && !returned; i++) {
            JSONObject step = steps.optJSONObject(i);
            tick();
            String op = step.optString("op");
            try {
                switch (op) {
                    case "set": variables.put(step.optString("name"), resolve(step.opt("value"))); checkData(); break;
                    case "sequence": run(step.optJSONArray("steps")); break;
                    case "if": run(truthy(resolve(step.opt("condition")))
                            ? step.optJSONArray("then") : step.optJSONArray("else")); break;
                    case "repeat":
                        for (int n = 0; n < step.optInt("times") && !returned; n++) run(step.optJSONArray("steps"));
                        break;
                    case "try":
                        try { run(step.optJSONArray("steps")); }
                        catch (ExecutionException failure) {
                            if (failure instanceof ControlException) throw failure;
                            variables.put("error", failure.getMessage());
                            checkData();
                            run(step.optJSONArray("recover"));
                        }
                        break;
                    case "call": call(step); break;
                    case "wait": host.waitMillis(step.optLong("millis")); checkWall(); break;
                    case "checkpoint": host.checkpoint(step.optString("name")); break;
                    case "return": returnValue = resolve(step.opt("value")); returned = true; break;
                    default: throw new ExecutionException("unvalidated op: " + op);
                }
            } catch (ExecutionException e) {
                throw e;
            } catch (Exception e) {
                throw new ExecutionException("operation " + op + " failed", e);
            }
        }
    }

    private void call(JSONObject step) throws ExecutionException {
        String capability = step.optString("capability");
        if (!allowedCapabilities.contains(capability)) {
            throw new ExecutionException("capability is not allowed: " + capability);
        }
        JSONObject source = step.optJSONObject("arguments");
        JSONObject arguments = source == null ? new JSONObject() : resolveObject(source);
        try {
            Object result = host.call(capability, arguments);
            if (step.has("assign")) variables.put(step.optString("assign"), normalize(result));
            checkData();
        } catch (Exception e) {
            throw new ExecutionException("host call failed: " + capability, e);
        }
    }

    private Object resolve(Object value) throws ExecutionException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            if (object.length() == 1 && object.has("var")) {
                String name = object.optString("var", null);
                if (name == null || !variables.containsKey(name)) throw new ExecutionException("unknown variable: " + name);
                return variables.get(name);
            }
            return resolveObject(object);
        }
        if (value instanceof JSONArray) {
            JSONArray source = (JSONArray) value;
            JSONArray result = new JSONArray();
            for (int i = 0; i < source.length(); i++) result.put(resolve(source.opt(i)));
            return result;
        }
        return normalize(value);
    }

    private JSONObject resolveObject(JSONObject source) throws ExecutionException {
        JSONObject result = new JSONObject();
        java.util.Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            try { result.put(key, resolve(source.opt(key))); }
            catch (JSONException e) { throw new ExecutionException("could not resolve argument", e); }
        }
        return result;
    }

    private void tick() throws ExecutionException {
        if (cancellation.isCancelled()) throw new ControlException("execution cancelled");
        if (++executed > limits.maxSteps) throw new ControlException("step budget exceeded");
        checkWall();
    }

    private void checkWall() throws ExecutionException {
        if (cancellation.isCancelled()) throw new ControlException("execution cancelled");
        if (host.monotonicTimeMillis() - startedAt > limits.maxWallMillis) {
            throw new ControlException("wall-time budget exceeded");
        }
    }

    private void checkData() throws ExecutionException {
        if (JSONObject.wrap(variables).toString().getBytes(StandardCharsets.UTF_8).length > limits.maxDataBytes) {
            throw new ControlException("data budget exceeded");
        }
    }

    private static boolean truthy(Object value) {
        if (value == null || value == JSONObject.NULL) return false;
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof Number) return ((Number) value).doubleValue() != 0;
        if (value instanceof String) return !((String) value).isEmpty();
        return true;
    }

    private static Object normalize(Object value) {
        return value == null ? JSONObject.NULL : value;
    }
}

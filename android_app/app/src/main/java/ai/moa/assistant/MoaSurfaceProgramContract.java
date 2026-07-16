package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Pattern;

/** Closed decoder for Android's first-class surface-local program proposal. */
final class MoaSurfaceProgramContract {
    static final int MAX_SOURCE_BYTES = 65_536;
    static final int MAX_WALL_MS = 30_000;
    static final int MAX_TOOL_CALLS = 100;
    static final int MAX_PARALLEL_CALLS = 1;
    static final int MAX_RESULT_BYTES = 65_536;
    static final int MAX_LOG_BYTES = 32_768;
    static final long MAX_LIFETIME_MS = 5 * 60_000L;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9._:-]{1,200}$");
    private static final Pattern SHA = Pattern.compile("^[a-f0-9]{64}$");
    private static final Set<String> ROOT = set("version", "type", "execution_id", "session_id", "turn_id", "target", "runtime", "program", "catalog", "bindings", "limits", "approval_policy", "idempotency_key", "issued_at", "expires_at");
    private static final Set<String> BINDINGS = set("kind", "observation_id", "observation_generation", "state_sha256", "package_name", "window_id");

    private MoaSurfaceProgramContract() {}

    static Proposal parse(JSONObject input, String localDeviceId, long nowMs) {
        exact(input, ROOT, "invalid_envelope_shape");
        integer(input, "version", 1, 1);
        rejectIf(!"surface.execution.proposed".equals(input.optString("type", "")), "unsupported_envelope");
        String executionId = id(input, "execution_id");
        String sessionId = id(input, "session_id");
        String turnId = id(input, "turn_id");
        String idempotencyKey = id(input, "idempotency_key");

        JSONObject target = object(input, "target");
        exact(target, set("surface_type", "device_id"), "invalid_target_shape");
        rejectIf(!"android".equals(target.optString("surface_type", "")), "wrong_surface");
        String deviceId = id(target, "device_id");
        rejectIf(!deviceId.equals(localDeviceId), "wrong_device");

        JSONObject runtime = object(input, "runtime");
        exact(runtime, set("runtime_id", "language", "bridge_version", "entrypoint"), "invalid_runtime_shape");
        rejectIf(!MoaScriptExecutionCatalog.RUNTIME_ID.equals(runtime.optString("runtime_id", "")), "runtime_mismatch");
        rejectIf(!"javascript".equals(runtime.optString("language", "")), "runtime_mismatch");
        integer(runtime, "bridge_version", 1, 1);
        rejectIf(!"main".equals(runtime.optString("entrypoint", "")), "runtime_mismatch");

        JSONObject program = object(input, "program");
        exact(program, set("source", "sha256"), "invalid_program_shape");
        String source = program.optString("source", null);
        String programSha = digest(program, "sha256");
        rejectIf(source == null, "program_hash_mismatch");
        rejectIf(source.trim().isEmpty(), "program_hash_mismatch");
        rejectIf(source.getBytes(StandardCharsets.UTF_8).length > MAX_SOURCE_BYTES, "program_hash_mismatch");
        rejectIf(!MoaProgramJson.sha256(source).equals(programSha), "program_hash_mismatch");

        JSONObject catalog = object(input, "catalog");
        exact(catalog, set("version", "sha256", "allowed_capability_ids"), "invalid_catalog_shape");
        integer(catalog, "version", MoaScriptExecutionCatalog.VERSION, MoaScriptExecutionCatalog.VERSION);
        rejectIf(!MoaScriptExecutionCatalog.sha256().equals(digest(catalog, "sha256")), "catalog_mismatch");
        Set<String> allowed = sortedStringSet(array(catalog, "allowed_capability_ids"), "invalid_capability_ids");
        rejectIf(!MoaScriptExecutionCatalog.ids().containsAll(allowed), "capability_escalation");

        JSONObject bindings = object(input, "bindings");
        exact(bindings, BINDINGS, "invalid_bindings_shape");
        rejectIf(!"android_accessibility".equals(bindings.optString("kind", "")), "invalid_binding_kind");
        String expectedPackage = id(bindings, "package_name");
        String windowId = id(bindings, "window_id");
        String observationId = id(bindings, "observation_id");
        long observationGeneration = integer(bindings, "observation_generation", 1, MAX_SAFE_INTEGER);
        String observationDigest = digest(bindings, "state_sha256");

        Limits limits = parseLimits(object(input, "limits"));
        rejectIf(source.getBytes(StandardCharsets.UTF_8).length > limits.sourceBytes, "source_bytes_mismatch");
        JSONObject approval = object(input, "approval_policy");
        exact(approval, set("program", "always_ask"), "invalid_approval_shape");
        String programApproval = text(approval, "program", 80);
        rejectIf(!"preauthorized".equals(programApproval) && !"local_policy".equals(programApproval)
                && !"approval_required".equals(programApproval), "invalid_approval_policy");
        Set<String> alwaysAsk = sortedStringSet(array(approval, "always_ask"), "invalid_approval_shape");
        rejectIf(!MoaScriptExecutionCatalog.EFFECT_CLASSES.containsAll(alwaysAsk), "approval_effect_escalation");

        long issuedAt = instant(input, "issued_at");
        long expiresAt = instant(input, "expires_at");
        rejectIf(expiresAt <= issuedAt, "invalid_expiry");
        rejectIf(expiresAt - issuedAt > MAX_LIFETIME_MS, "invalid_expiry");
        rejectIf(nowMs < issuedAt - 30_000L, "invalid_expiry");
        rejectIf(nowMs >= expiresAt, "expired");
        return new Proposal(executionId, sessionId, turnId, deviceId, source, programSha,
                digest(catalog, "sha256"), allowed, MoaProgramJson.copy(bindings),
                MoaProgramJson.sha256(MoaProgramJson.canonical(bindings)), expectedPackage, windowId,
                observationId, observationGeneration, observationDigest, limits, programApproval, alwaysAsk,
                idempotencyKey, issuedAt, expiresAt, MoaProgramJson.sha256(MoaProgramJson.canonical(input)));
    }

    /** Decodes only cryptographic receipt identity; never authorizes execution. */
    static Proposal receiptIdentity(JSONObject input, String localDeviceId) {
        try {
            String executionId = id(input, "execution_id"), sessionId = id(input, "session_id");
            String turnId = id(input, "turn_id"), idempotencyKey = id(input, "idempotency_key");
            JSONObject target = object(input, "target");
            String deviceId = id(target, "device_id");
            rejectIf(!deviceId.equals(localDeviceId), "wrong_device");
            JSONObject program = object(input, "program"), catalog = object(input, "catalog");
            String programSha = digest(program, "sha256"), catalogSha = digest(catalog, "sha256");
            JSONObject bindings = object(input, "bindings");
            String bindingsSha = MoaProgramJson.sha256(MoaProgramJson.canonical(bindings));
            String proposalSha = MoaProgramJson.sha256(MoaProgramJson.canonical(input));
            return new Proposal(executionId, sessionId, turnId, deviceId, "", programSha, catalogSha,
                    Collections.emptySet(), MoaProgramJson.copy(bindings), bindingsSha, "", "", "", 1,
                    "", new Limits(1, 100, 1, 1, 1, 0), "local_policy", Collections.emptySet(),
                    idempotencyKey, 0, 0, proposalSha);
        } catch (Exception rejected) { return null; }
    }

    private static Limits parseLimits(JSONObject input) {
        exact(input, set("source_bytes", "wall_ms", "memory_bytes", "tool_calls", "parallel_calls", "result_bytes", "log_bytes"), "invalid_limits_shape");
        rejectIf(input.opt("memory_bytes") != JSONObject.NULL, "invalid_memory_bytes");
        return new Limits(
                integer(input, "source_bytes", 1, MAX_SOURCE_BYTES),
                integer(input, "wall_ms", 100, MAX_WALL_MS),
                integer(input, "tool_calls", 1, MAX_TOOL_CALLS),
                integer(input, "parallel_calls", 1, MAX_PARALLEL_CALLS),
                integer(input, "result_bytes", 1, MAX_RESULT_BYTES),
                integer(input, "log_bytes", 0, MAX_LOG_BYTES));
    }

    static final class Proposal {
        final String executionId, sessionId, turnId, deviceId, source, programSha256, catalogSha256;
        final Set<String> allowedCapabilityIds;
        final JSONObject bindings;
        final String bindingsSha256, expectedPackage, windowId, observationId, observationDigest;
        final long observationGeneration, issuedAtMs, expiresAtMs;
        final Limits limits;
        final String programApproval, idempotencyKey, proposalSha256;
        final Set<String> alwaysAsk;

        Proposal(String executionId, String sessionId, String turnId, String deviceId, String source,
                 String programSha256, String catalogSha256, Set<String> allowedCapabilityIds,
                 JSONObject bindings, String bindingsSha256, String expectedPackage, String windowId,
                 String observationId, long observationGeneration, String observationDigest, Limits limits, String programApproval, Set<String> alwaysAsk,
                 String idempotencyKey, long issuedAtMs, long expiresAtMs, String proposalSha256) {
            this.executionId = executionId; this.sessionId = sessionId; this.turnId = turnId; this.deviceId = deviceId;
            this.source = source; this.programSha256 = programSha256; this.catalogSha256 = catalogSha256;
            this.allowedCapabilityIds = Collections.unmodifiableSet(new LinkedHashSet<>(allowedCapabilityIds));
            this.bindings = bindings; this.bindingsSha256 = bindingsSha256; this.expectedPackage = expectedPackage;
            this.windowId = windowId; this.observationId = observationId; this.observationGeneration = observationGeneration;
            this.observationDigest = observationDigest; this.limits = limits; this.programApproval = programApproval;
            this.alwaysAsk = Collections.unmodifiableSet(new LinkedHashSet<>(alwaysAsk)); this.idempotencyKey = idempotencyKey; this.issuedAtMs = issuedAtMs; this.expiresAtMs = expiresAtMs; this.proposalSha256 = proposalSha256;
        }
    }

    static final class Limits {
        final int sourceBytes, wallMs, toolCalls, parallelCalls, resultBytes, logBytes;
        Limits(long sourceBytes, long wallMs, long toolCalls, long parallelCalls, long resultBytes, long logBytes) {
            this.sourceBytes = (int) sourceBytes; this.wallMs = (int) wallMs;
            this.toolCalls = (int) toolCalls; this.parallelCalls = (int) parallelCalls;
            this.resultBytes = (int) resultBytes; this.logBytes = (int) logBytes;
        }
    }

    static final class Rejected extends IllegalArgumentException {
        final String code;
        Rejected(String code) { super(code); this.code = code; }
    }

    private static JSONObject object(JSONObject input, String key) { Object value = input.opt(key); rejectIf(!(value instanceof JSONObject), "invalid_" + key); return (JSONObject) value; }
    private static JSONArray array(JSONObject input, String key) { Object value = input.opt(key); rejectIf(!(value instanceof JSONArray), "invalid_" + key); return (JSONArray) value; }
    private static String id(JSONObject input, String key) { String value = input.optString(key, null); rejectIf(value == null, "invalid_" + key); rejectIf(!ID.matcher(value).matches(), "invalid_" + key); return value; }
    private static String text(JSONObject input, String key, int max) { String value = input.optString(key, null); rejectIf(value == null, "invalid_" + key); rejectIf(value.trim().isEmpty(), "invalid_" + key); rejectIf(value.length() > max, "invalid_" + key); return value; }
    private static String digest(JSONObject input, String key) { String value = input.optString(key, null); rejectIf(value == null, "invalid_" + key); rejectIf(!SHA.matcher(value).matches(), "invalid_" + key); return value; }
    private static long integer(JSONObject input, String key, long min, long max) { Object raw = input.opt(key); rejectIf(!(raw instanceof Number), "invalid_" + key); double value = ((Number) raw).doubleValue(); long integer = ((Number) raw).longValue(); rejectIf(!Double.isFinite(value), "invalid_" + key); rejectIf(value != integer, "invalid_" + key); rejectIf(integer < min, "invalid_" + key); rejectIf(integer > max, "invalid_" + key); return integer; }
    private static long instant(JSONObject input, String key) { try { String raw = input.getString(key); rejectIf(!raw.matches("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"), "invalid_" + key); return Instant.parse(raw).toEpochMilli(); } catch (Rejected error) { throw error; } catch (Exception error) { fail("invalid_" + key); return 0; } }
    private static Set<String> sortedStringSet(JSONArray input, String code) { Set<String> result = new LinkedHashSet<>(); String previous = null; for (int i = 0; i < input.length(); i++) { Object value = input.opt(i); rejectIf(!(value instanceof String) || !ID.matcher((String) value).matches() || !result.add((String) value), code); String current = (String) value; rejectIf(previous != null && previous.compareTo(current) >= 0, code); previous = current; } return result; }
    private static void exact(JSONObject input, Set<String> expected, String code) { rejectIf(input == null, code); Set<String> actual = new HashSet<>(); Iterator<String> keys = input.keys(); while (keys.hasNext()) actual.add(keys.next()); rejectIf(!actual.equals(expected), code); }
    private static Set<String> set(String... values) { return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values))); }
    private static void fail(String code) { throw new Rejected(code); }
    private static void rejectIf(boolean rejected, String code) {
        if (rejected) throw new Rejected(code);
    }
}

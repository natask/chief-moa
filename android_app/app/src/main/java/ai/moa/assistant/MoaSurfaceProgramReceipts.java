package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.util.UUID;

/** Constructs redacted, digest-bound tool and terminal receipts. */
final class MoaSurfaceProgramReceipts {
    private static final java.util.Set<String> TOOL_STATUSES = java.util.Set.of("succeeded", "failed", "rejected", "stale_state", "timed_out", "stopped", "indeterminate");
    private static final java.util.Set<String> TERMINAL_STATUSES = java.util.Set.of("rejected", "completed", "failed", "timed_out", "stopped", "interrupted", "indeterminate");
    private MoaSurfaceProgramReceipts() {}

    static JSONObject tool(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId,
                           String callId, int attempt, String capabilityId, JSONObject input,
                           String status, String summary, String dataDigest, String previousDigest,
                           long startedAtMs, long finishedAtMs) {
        return toolBound(proposal, clientInstanceId, callId, attempt, capabilityId, input, status, previousDigest,
                proposal.observationDigest, null, startedAtMs, finishedAtMs);
    }

    static JSONObject toolBound(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId,
                           String callId, int attempt, String capabilityId, JSONObject input,
                           String status, String previousDigest, String preStateDigest, String postStateDigest,
                           long startedAtMs, long finishedAtMs) {
        return toolFromDigest(proposal, clientInstanceId, callId, attempt, capabilityId,
                MoaProgramJson.sha256(MoaProgramJson.canonical(input)), status, previousDigest, preStateDigest, postStateDigest, startedAtMs, finishedAtMs);
    }

    static JSONObject toolFromDigest(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId,
                           String callId, int attempt, String capabilityId, String inputSha256,
                           String status, String previousDigest, String preStateDigest, String postStateDigest,
                           long startedAtMs, long finishedAtMs) {
        try {
        if (!TOOL_STATUSES.contains(status)) throw new IllegalArgumentException("invalid_tool_status");
        if ("succeeded".equals(status) && MoaScriptExecutionCatalog.isMutation(capabilityId) && postStateDigest == null) throw new IllegalArgumentException("missing_post_state");
        JSONObject receipt = new JSONObject()
                .put("version", 1).put("type", "surface.execution.tool_receipt")
                .put("receipt_id", "tool_receipt_" + UUID.randomUUID())
                .put("execution_id", proposal.executionId)
                .put("claimant", claimant(proposal, clientInstanceId))
                .put("tool_call_id", callId).put("attempt", attempt).put("capability_id", capabilityId)
                .put("program_sha256", proposal.programSha256).put("catalog_sha256", proposal.catalogSha256)
                .put("bindings_sha256", proposal.bindingsSha256)
                .put("input_sha256", inputSha256)
                .put("pre_state_sha256", preStateDigest).put("approval_id", JSONObject.NULL)
                .put("started_at", MoaSurfaceProgramEvents.timestamp(startedAtMs))
                .put("finished_at", MoaSurfaceProgramEvents.timestamp(finishedAtMs))
                .put("status", status)
                .put("result", new JSONObject().put("summary", toolSummary(status))
                        .put("data_sha256", JSONObject.NULL).put("resource_id", JSONObject.NULL))
                .put("post_state_sha256", emptyToNull(postStateDigest))
                .put("previous_receipt_sha256", emptyToNull(previousDigest));
        receipt.put("receipt_sha256", digestWithoutField(receipt, "receipt_sha256"));
        return receipt;
        } catch (Exception error) { throw new IllegalStateException("Unable to encode tool receipt", error); }
    }

    static JSONObject terminal(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId,
                               String status, String summary, String resultDigest, String errorCode,
                               String errorMessage, JSONArray attempts, long startedAtMs, long finishedAtMs) {
        return terminal(proposal, clientInstanceId, status, attempts, startedAtMs, finishedAtMs, null, normalizeCode(status, errorCode));
    }

    static JSONObject terminal(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId,
                               String status, JSONArray attempts, long startedAtMs, long finishedAtMs,
                               String finalStateDigest, String errorCode) {
        try {
        if (!TERMINAL_STATUSES.contains(status)) throw new IllegalArgumentException("invalid_terminal_status");
        String normalizedCode = "completed".equals(status) ? null : normalizeCode(status, errorCode);
        String first = attempts.length() == 0 ? "" : attempts.getJSONObject(0).optString("receipt_sha256", "");
        String last = attempts.length() == 0 ? "" : attempts.getJSONObject(attempts.length() - 1).optString("receipt_sha256", "");
        JSONObject receipt = new JSONObject()
                .put("version", 1).put("type", "surface.execution.receipt")
                .put("receipt_id", "receipt_" + UUID.randomUUID()).put("execution_id", proposal.executionId)
                .put("session_id", proposal.sessionId).put("turn_id", proposal.turnId)
                .put("claimant", claimant(proposal, clientInstanceId)).put("runtime_id", MoaScriptExecutionCatalog.RUNTIME_ID)
                .put("program_sha256", proposal.programSha256).put("catalog_sha256", proposal.catalogSha256)
                .put("bindings_sha256", proposal.bindingsSha256)
                .put("started_at", startedAtMs <= 0 ? JSONObject.NULL : MoaSurfaceProgramEvents.timestamp(startedAtMs))
                .put("finished_at", MoaSurfaceProgramEvents.timestamp(finishedAtMs)).put("status", status)
                .put("tool_attempts", new JSONObject().put("count", attempts.length()).put("first_receipt_sha256", emptyToNull(first)).put("last_receipt_sha256", emptyToNull(last)))
                .put("result", new JSONObject().put("summary", terminalSummary(status)).put("data_sha256", JSONObject.NULL).put("artifact_refs", new JSONArray()))
                .put("final_state_sha256", emptyToNull(finalStateDigest))
                .put("error", new JSONObject().put("code", emptyToNull(normalizedCode)).put("message", emptyToNull(normalizedCode == null ? null : terminalError(normalizedCode))))
                .put("previous_receipt_sha256", emptyToNull(last));
        receipt.put("receipt_sha256", digestWithoutField(receipt, "receipt_sha256"));
        return receipt;
        } catch (Exception error) { throw new IllegalStateException("Unable to encode terminal receipt", error); }
    }

    static String digestWithoutField(JSONObject input, String field) {
        JSONObject copy = MoaProgramJson.copy(input); copy.remove(field);
        return MoaProgramJson.sha256(MoaProgramJson.canonical(copy));
    }

    private static JSONObject claimant(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId) {
        try { return new JSONObject().put("surface_type", "android").put("device_id", proposal.deviceId).put("client_instance_id", clientInstanceId); }
        catch (Exception error) { throw new IllegalStateException("Unable to encode claimant", error); }
    }
    private static Object emptyToNull(String value) { return value == null || value.isEmpty() ? JSONObject.NULL : value; }
    private static String toolSummary(String status) { return "succeeded".equals(status) ? "Local capability completed." : "Local capability ended without success."; }
    private static String terminalSummary(String status) { return "completed".equals(status) ? "Android local program completed." : "Android local program ended without completion."; }
    private static String terminalError(String code) { return "Local execution ended: " + code.replace('_', ' ') + "."; }
    private static String normalizeCode(String status, String code) {
        if ("completed".equals(status)) return null;
        if ("rejected".equals(status)) return java.util.Set.of("proposal_rejected", "policy_denied", "stale_state", "unsupported_profile").contains(code) ? code : "proposal_rejected";
        if ("failed".equals(status)) return java.util.Set.of("runtime_failed", "tool_failed", "receipt_failed", "limit_exceeded").contains(code) ? code : "runtime_failed";
        if ("timed_out".equals(status)) return "timeout";
        if ("stopped".equals(status)) return java.util.Set.of("user_stop", "policy_revoked", "surface_shutdown").contains(code) ? code : "user_stop";
        if ("interrupted".equals(status)) return "surface_shutdown".equals(code) ? code : "runtime_interrupted";
        return "indeterminate";
    }
}

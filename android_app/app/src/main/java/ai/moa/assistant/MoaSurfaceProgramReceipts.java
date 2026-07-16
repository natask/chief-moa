package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.util.UUID;

/** Constructs redacted, digest-bound tool and terminal receipts. */
final class MoaSurfaceProgramReceipts {
    private MoaSurfaceProgramReceipts() {}

    static JSONObject tool(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId,
                           String callId, int attempt, String capabilityId, JSONObject input,
                           String status, String summary, String dataDigest, String previousDigest,
                           long startedAtMs, long finishedAtMs) {
        try {
        JSONObject receipt = new JSONObject()
                .put("version", 1).put("type", "surface.execution.tool_receipt")
                .put("receipt_id", "tool_receipt_" + UUID.randomUUID())
                .put("execution_id", proposal.executionId)
                .put("claimant", claimant(proposal, clientInstanceId))
                .put("tool_call_id", callId).put("attempt", attempt).put("capability_id", capabilityId)
                .put("program_sha256", proposal.programSha256).put("catalog_sha256", proposal.catalogSha256)
                .put("bindings_sha256", proposal.bindingsSha256)
                .put("input_sha256", MoaProgramJson.sha256(MoaProgramJson.canonical(input)))
                .put("pre_state_sha256", proposal.observationDigest).put("approval_id", JSONObject.NULL)
                .put("started_at", Instant.ofEpochMilli(startedAtMs).toString())
                .put("finished_at", Instant.ofEpochMilli(finishedAtMs).toString())
                .put("status", status)
                .put("result", new JSONObject().put("summary", bounded(summary, 240))
                        .put("data_sha256", emptyToNull(dataDigest)).put("resource_id", JSONObject.NULL))
                .put("post_state_sha256", JSONObject.NULL)
                .put("previous_receipt_sha256", emptyToNull(previousDigest));
        receipt.put("receipt_sha256", digestWithoutField(receipt, "receipt_sha256"));
        return receipt;
        } catch (Exception error) { throw new IllegalStateException("Unable to encode tool receipt", error); }
    }

    static JSONObject terminal(MoaSurfaceProgramContract.Proposal proposal, String clientInstanceId,
                               String status, String summary, String resultDigest, String errorCode,
                               String errorMessage, JSONArray attempts, long startedAtMs, long finishedAtMs) {
        try {
        String first = attempts.length() == 0 ? "" : attempts.getJSONObject(0).optString("receipt_sha256", "");
        String last = attempts.length() == 0 ? "" : attempts.getJSONObject(attempts.length() - 1).optString("receipt_sha256", "");
        JSONObject receipt = new JSONObject()
                .put("version", 1).put("type", "surface.execution.receipt")
                .put("receipt_id", "receipt_" + UUID.randomUUID()).put("execution_id", proposal.executionId)
                .put("session_id", proposal.sessionId).put("turn_id", proposal.turnId)
                .put("claimant", claimant(proposal, clientInstanceId)).put("runtime_id", MoaScriptExecutionCatalog.RUNTIME_ID)
                .put("program_sha256", proposal.programSha256).put("catalog_sha256", proposal.catalogSha256)
                .put("bindings_sha256", proposal.bindingsSha256)
                .put("started_at", startedAtMs <= 0 ? JSONObject.NULL : Instant.ofEpochMilli(startedAtMs).toString())
                .put("finished_at", Instant.ofEpochMilli(finishedAtMs).toString()).put("status", status)
                .put("tool_attempts", new JSONObject().put("count", attempts.length()).put("first_receipt_sha256", emptyToNull(first)).put("last_receipt_sha256", emptyToNull(last)))
                .put("result", new JSONObject().put("summary", bounded(summary, 240)).put("data_sha256", emptyToNull(resultDigest)).put("artifact_refs", new JSONArray()))
                .put("final_state_sha256", JSONObject.NULL)
                .put("error", new JSONObject().put("code", emptyToNull(errorCode)).put("message", emptyToNull(bounded(errorMessage, 240))))
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
    private static String bounded(String value, int max) { String safe = value == null ? "" : value.replaceAll("[\\r\\n\\t]+", " ").trim(); return safe.length() <= max ? safe : safe.substring(0, max); }
}

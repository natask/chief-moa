package ai.moa.assistant;

import org.json.JSONObject;

import java.time.Instant;
import java.util.UUID;

/** Closed constructors for locally sequenced surface execution lifecycle events. */
final class MoaSurfaceProgramEvents {
    private MoaSurfaceProgramEvents() {}

    static JSONObject event(MoaSurfaceProgramContract.Proposal proposal, String clientId, int sequence,
                            String kind, JSONObject payload, long occurredAtMs) {
        return object("version", 1, "type", "surface.execution.event", "event_id", "event_" + UUID.randomUUID(),
                "execution_id", proposal.executionId, "sequence", sequence, "kind", kind, "occurred_at", timestamp(occurredAtMs),
                "claimant", object("surface_type", "android", "device_id", proposal.deviceId, "client_instance_id", clientId), "payload", payload);
    }

    static JSONObject accepted(MoaSurfaceProgramContract.Proposal p, String client, int seq, long at) {
        return event(p, client, seq, "accepted", object("proposal_sha256", p.proposalSha256), at);
    }
    static JSONObject started(MoaSurfaceProgramContract.Proposal p, String client, int seq, long at) { return event(p, client, seq, "started", new JSONObject(), at); }
    static JSONObject toolStarted(MoaSurfaceProgramContract.Proposal p, String client, int seq, String capability, String call, long at) {
        return event(p, client, seq, "tool_started", object("capability_id", capability, "tool_call_id", call, "attempt", 1), at);
    }
    static JSONObject toolFinished(MoaSurfaceProgramContract.Proposal p, String client, int seq, String capability, String call, JSONObject receipt, long at) {
        return event(p, client, seq, "tool_finished", object("capability_id", capability, "tool_call_id", call, "attempt", 1,
                "status", receipt.optString("status"), "receipt_id", receipt.optString("receipt_id"), "receipt_sha256", receipt.optString("receipt_sha256")), at);
    }
    static JSONObject stopping(MoaSurfaceProgramContract.Proposal p, String client, int seq, String reason, long at) {
        return event(p, client, seq, "stopping", object("reason", reason), at);
    }
    static JSONObject terminal(MoaSurfaceProgramContract.Proposal p, String client, int seq, JSONObject receipt, long at) {
        return event(p, client, seq, "terminal", object("status", receipt.optString("status"),
                "receipt_id", receipt.optString("receipt_id"), "receipt_sha256", receipt.optString("receipt_sha256")), at);
    }

    static String timestamp(long epochMs) {
        String value = Instant.ofEpochMilli(epochMs).toString();
        return value.matches(".*\\.\\d{3}Z$") ? value : value.replace("Z", ".000Z");
    }

    private static JSONObject object(Object... pairs) { try { JSONObject value = new JSONObject(); for (int i = 0; i < pairs.length; i += 2) value.put(String.valueOf(pairs[i]), pairs[i + 1]); return value; } catch (Exception error) { throw new IllegalStateException(error); } }
}

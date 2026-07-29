package ai.moa.assistant;

import org.json.JSONObject;

import java.time.Instant;
import java.util.List;
import java.util.Locale;

/** Strict, non-executing Android adapter for explicit modification requests. */
final class MoaModificationRequestPolicy {
    private static final String ID = "[A-Za-z0-9._:-]{1,160}";
    private static final String SHA256 = "[a-f0-9]{64}";
    private static final int MAX_OBJECTIVE_CHARS = 16_000;
    private static final List<String> STATES = List.of(
            "queued", "owned", "running", "qa", "candidate", "blocked", "failed",
            "completed", "reclaimable");

    static final class Status {
        final String requestId;
        final String feedbackId;
        final String state;
        final String blockingReason;
        final String intentId;
        final String taskId;
        final String runId;
        final String ownerId;
        final String leaseId;
        final String qaId;
        final String artifactId;
        final String previewId;

        Status(String requestId, String feedbackId, String state, String blockingReason,
               String intentId, String taskId, String runId, String ownerId, String leaseId,
               String qaId, String artifactId, String previewId) {
            this.requestId = requestId;
            this.feedbackId = feedbackId;
            this.state = state;
            this.blockingReason = blockingReason;
            this.intentId = intentId;
            this.taskId = taskId;
            this.runId = runId;
            this.ownerId = ownerId;
            this.leaseId = leaseId;
            this.qaId = qaId;
            this.artifactId = artifactId;
            this.previewId = previewId;
        }

        boolean terminal() {
            return "failed".equals(state) || "completed".equals(state);
        }

        JSONObject toJson() throws Exception {
            return new JSONObject()
                    .put("request_id", requestId).put("feedback_id", feedbackId)
                    .put("state", state).put("blocking_reason", blockingReason)
                    .put("intent_id", intentId).put("task_id", taskId).put("run_id", runId)
                    .put("owner_id", ownerId).put("lease_id", leaseId)
                    .put("qa_id", qaId).put("artifact_id", artifactId).put("preview_id", previewId);
        }
    }

    private MoaModificationRequestPolicy() { }

    static String parseFeedbackId(JSONObject response) {
        if (response == null) throw new IllegalArgumentException("feedback receipt is missing");
        JSONObject feedback = requiredObject(response, "feedback");
        return requireId(feedback.optString("feedback_id", ""), "feedback_id");
    }

    static JSONObject createRequest(
            String feedbackId, String deviceId, MoaReleaseSelectionPolicy.Assignment assignment,
            MoaReleaseSelectionPolicy.Candidate candidate, String objective,
            String authorizedAt, String idempotencyKey) throws Exception {
        String boundedObjective = safe(objective);
        if (boundedObjective.isEmpty() || boundedObjective.length() > MAX_OBJECTIVE_CHARS) {
            throw new IllegalArgumentException("objective must be 1-" + MAX_OBJECTIVE_CHARS + " characters");
        }
        if (assignment == null || candidate == null || candidate.artifact == null
                || assignment.assignmentId.isEmpty()
                || !assignment.bundleId.equals(candidate.bundleId)
                || !assignment.releaseId.equals(candidate.releaseId)
                || !assignment.channel.equals(candidate.channel)
                || (!assignment.artifactSha256.isEmpty()
                && !assignment.artifactSha256.equals(candidate.artifact.sha256))) {
            throw new IllegalArgumentException("Create fix requires the exact feedback release assignment");
        }
        String timestamp = safe(authorizedAt);
        try { Instant.parse(timestamp); } catch (Exception error) {
            throw new IllegalArgumentException("authorization timestamp is invalid");
        }
        return new JSONObject()
                .put("schema", "modification_request.v1")
                .put("feedback_id", requireId(feedbackId, "feedback_id"))
                .put("device_id", requireId(deviceId, "device_id"))
                .put("assignment_id", requireId(assignment.assignmentId, "assignment_id"))
                .put("bundle_id", requireId(candidate.bundleId, "bundle_id"))
                .put("surface", "android")
                .put("release_id", requireId(candidate.releaseId, "release_id"))
                .put("artifact_sha256", requireSha(candidate.artifact.sha256))
                .put("objective", boundedObjective)
                .put("authorization", new JSONObject()
                        .put("kind", "implementation_authorized")
                        .put("authorized", true)
                        .put("authorized_at", timestamp))
                .put("idempotency_key", requireId(idempotencyKey, "idempotency_key"));
    }

    static Status parseCreateResponse(JSONObject response) {
        if (response == null) throw new IllegalArgumentException("modification response is missing");
        JSONObject request = requiredObject(response, "modification_request");
        JSONObject identities = requiredObject(response, "identities");
        JSONObject lease = requiredObject(response, "owner_lease");
        JSONObject status = requiredObject(response, "status");
        if (!"modification_status.v1".equals(status.optString("schema", ""))) {
            throw new IllegalArgumentException("modification status schema is invalid");
        }
        String requestId = requireId(request.optString("request_id", ""), "request_id");
        if (!requestId.equals(requireId(identities.optString("request_id", ""), "identities.request_id"))) {
            throw new IllegalArgumentException("modification request identities do not match");
        }
        String ownerId = requireId(identities.optString("owner_id", ""), "owner_id");
        String leaseId = requireId(identities.optString("lease_id", ""), "lease_id");
        if (!ownerId.equals(requireId(lease.optString("owner_id", ""), "owner_lease.owner_id"))
                || !leaseId.equals(requireId(lease.optString("lease_id", ""), "owner_lease.lease_id"))) {
            throw new IllegalArgumentException("modification owner lease does not match");
        }
        return parseStatus(status, requestId,
                requireId(request.optString("feedback_id", ""), "feedback_id"), identities);
    }

    static Status parseStatusResponse(JSONObject response, String expectedRequestId) {
        if (response == null) throw new IllegalArgumentException("modification status is missing");
        JSONObject status = response.optJSONObject("status");
        if (status == null) status = response;
        if (!"modification_status.v1".equals(status.optString("schema", ""))) {
            throw new IllegalArgumentException("modification status schema is invalid");
        }
        JSONObject request = requiredObject(status, "request");
        String requestId = requireId(objectId(request, "request_id"), "status.request_id");
        if (!requestId.equals(requireId(expectedRequestId, "expected_request_id"))) {
            throw new IllegalArgumentException("modification status names another request");
        }
        return parseStatus(status, requestId,
                requireId(request.optString("feedback_id", ""), "status.feedback_id"),
                requiredObject(status, "identities"));
    }

    static Status parseStored(JSONObject stored) {
        if (stored == null) throw new IllegalArgumentException("stored status is missing");
        return new Status(
                requireId(stored.optString("request_id", ""), "request_id"),
                requireId(stored.optString("feedback_id", ""), "feedback_id"),
                requireState(stored.optString("state", "")), bounded(stored.optString("blocking_reason", ""), 1000),
                optionalId(stored.optString("intent_id", "")), optionalId(stored.optString("task_id", "")),
                optionalId(stored.optString("run_id", "")), optionalId(stored.optString("owner_id", "")),
                optionalId(stored.optString("lease_id", "")), optionalId(stored.optString("qa_id", "")),
                optionalId(stored.optString("artifact_id", "")), optionalId(stored.optString("preview_id", "")));
    }

    private static Status parseStatus(JSONObject status, String requestId, String feedbackId,
                                      JSONObject creationIdentities) {
        String state = requireState(status.optString("state", ""));
        JSONObject request = optionalObject(status, "request");
        if (request != null && !requestId.equals(requireId(objectId(request, "request_id"), "status.request_id"))) {
            throw new IllegalArgumentException("modification status request does not match");
        }
        JSONObject intent = optionalObject(status, "intent");
        JSONObject task = optionalObject(status, "task");
        JSONObject run = optionalObject(status, "run");
        JSONObject owner = optionalObject(status, "owner_lease");
        String intentId = identity(creationIdentities, intent, "intent_id");
        String taskId = identity(creationIdentities, task, "task_id");
        String runId = identity(creationIdentities, run, "run_id");
        String ownerId = identity(creationIdentities, owner, "owner_id");
        String leaseId = creationIdentities == null ? optionalId(objectId(owner, "lease_id"))
                : requireId(creationIdentities.optString("lease_id", ""), "lease_id");
        if (("queued".equals(state) || "owned".equals(state) || "running".equals(state)
                || "qa".equals(state) || "candidate".equals(state))
                && (ownerId.isEmpty() || runId.isEmpty())) {
            throw new IllegalArgumentException("nonterminal modification status is ownerless");
        }
        String blocker = bounded(status.optString("blocking_reason", ""), 1000);
        if (("blocked".equals(state) || "reclaimable".equals(state)) && blocker.isEmpty()) {
            throw new IllegalArgumentException("blocked modification status requires a reason");
        }
        return new Status(requestId, feedbackId, state, blocker, intentId, taskId, runId,
                ownerId, leaseId, objectIdentity(status, "qa"), objectIdentity(status, "artifact"),
                objectIdentity(status, "preview"));
    }

    private static String identity(JSONObject identities, JSONObject projection, String name) {
        if (identities != null) return requireId(identities.optString(name, ""), name);
        return optionalId(objectId(projection, name));
    }

    private static String objectIdentity(JSONObject parent, String name) {
        return optionalId(objectId(optionalObject(parent, name), name + "_id"));
    }

    private static String objectId(JSONObject value, String preferred) {
        if (value == null) return "";
        return value.optString(preferred, value.optString("id", ""));
    }

    private static JSONObject requiredObject(JSONObject parent, String name) {
        JSONObject value = parent.optJSONObject(name);
        if (value == null) throw new IllegalArgumentException(name + " is missing");
        return value;
    }

    private static JSONObject optionalObject(JSONObject parent, String name) {
        return parent == null ? null : parent.optJSONObject(name);
    }

    private static String requireState(String value) {
        String state = safe(value).toLowerCase(Locale.US);
        if (!STATES.contains(state)) throw new IllegalArgumentException("modification status is unsupported");
        return state;
    }

    private static String requireSha(String value) {
        String sha = safe(value).toLowerCase(Locale.US);
        if (!sha.matches(SHA256)) throw new IllegalArgumentException("artifact_sha256 is invalid");
        return sha;
    }

    private static String requireId(String value, String name) {
        String id = safe(value);
        if (!id.matches(ID)) throw new IllegalArgumentException(name + " is invalid");
        return id;
    }

    private static String optionalId(String value) {
        String id = safe(value);
        if (id.isEmpty()) return "";
        return requireId(id, "identity");
    }

    private static String bounded(String value, int max) {
        String text = safe(value);
        if (text.length() > max) throw new IllegalArgumentException("status text is too large");
        return text;
    }

    private static String safe(String value) { return value == null ? "" : value; }
}

package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public final class MoaModificationRequestPolicyTest {
    private static final String SHA = "a".repeat(64);

    @Test
    public void explicitCreateFixBindsFeedbackAndExactRelease() throws Exception {
        MoaReleaseSelectionPolicy.Assignment assignment = new MoaReleaseSelectionPolicy.Assignment(
                "assignment-1", 3L, "device", "preview", "bundle-1", "release-1", SHA);
        MoaReleaseSelectionPolicy.Candidate candidate = new MoaReleaseSelectionPolicy.Candidate(
                "release-1", "bundle-1", "preview", "origin/master", true, "",
                new MoaReleaseSelectionPolicy.Artifact("ai.moa.assistant", 4L, "4", SHA, 10L,
                        "https://example.test/app.apk"));

        JSONObject body = MoaModificationRequestPolicy.createRequest(
                "feedback-1", "android-1", assignment, candidate, "Fix the ribbon.",
                new MoaCreateFixAuthorization(
                        "feedback-1", "create-fix-1", "2026-07-28T12:00:00Z"));

        assertEquals("modification_request.v1", body.getString("schema"));
        assertEquals("feedback-1", body.getString("feedback_id"));
        assertEquals(SHA, body.getString("artifact_sha256"));
        assertEquals("implementation_authorized",
                body.getJSONObject("authorization").getString("kind"));
        assertEquals(true, body.getJSONObject("authorization").getBoolean("authorized"));
    }

    @Test
    public void createResponseRequiresOwnerAndAllIdentities() throws Exception {
        JSONObject response = createResponse("queued");
        MoaModificationRequestPolicy.Status status =
                MoaModificationRequestPolicy.parseCreateResponse(response);
        assertEquals("request-1", status.requestId);
        assertEquals("intent-1", status.intentId);
        assertEquals("run-1", status.runId);
        assertEquals("owner-1", status.ownerId);
        assertFalse(status.terminal());

        response.getJSONObject("identities").put("owner_id", "");
        try {
            MoaModificationRequestPolicy.parseCreateResponse(response);
        } catch (IllegalArgumentException expected) {
            assertEquals("owner_id is invalid", expected.getMessage());
            return;
        }
        throw new AssertionError("Expected ownerless response rejection");
    }

    @Test
    public void durableProjectionPreservesBlockedReasonAndIdentities() throws Exception {
        JSONObject response = createResponse("blocked");
        response.getJSONObject("status").put("blocking_reason", "base drift");
        MoaModificationRequestPolicy.Status parsed =
                MoaModificationRequestPolicy.parseCreateResponse(response);
        MoaModificationRequestPolicy.Status restored =
                MoaModificationRequestPolicy.parseStored(parsed.toJson());
        assertEquals("blocked", restored.state);
        assertEquals("base drift", restored.blockingReason);
        assertEquals("task-1", restored.taskId);
    }

    @Test
    public void parsesCanonicalGetStatusEnvelope() throws Exception {
        JSONObject created = createResponse("running");
        JSONObject status = created.getJSONObject("status")
                .put("identities", created.getJSONObject("identities"))
                .put("owner_lease", created.getJSONObject("owner_lease"));
        status.getJSONObject("request").put("feedback_id", "feedback-1");

        MoaModificationRequestPolicy.Status parsed =
                MoaModificationRequestPolicy.parseStatusResponse(
                        new JSONObject().put("status", status), "request-1");

        assertEquals("running", parsed.state);
        assertEquals("owner-1", parsed.ownerId);
        assertEquals("lease-1", parsed.leaseId);
    }

    @Test
    public void feedbackReceiptMustContainTypedIdentity() throws Exception {
        assertEquals("feedback-1", MoaModificationRequestPolicy.parseFeedbackId(
                new JSONObject().put("feedback", new JSONObject().put("feedback_id", "feedback-1"))));
        try {
            MoaModificationRequestPolicy.parseFeedbackId(new JSONObject().put("feedback_id", "feedback-1"));
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("Expected loose feedback response rejection");
    }

    private static JSONObject createResponse(String state) throws Exception {
        JSONObject identities = new JSONObject()
                .put("request_id", "request-1").put("intent_id", "intent-1")
                .put("task_id", "task-1").put("run_id", "run-1")
                .put("owner_id", "owner-1").put("lease_id", "lease-1");
        return new JSONObject()
                .put("modification_request", new JSONObject()
                        .put("request_id", "request-1").put("feedback_id", "feedback-1")
                        .put("status", state).put("blocking_reason", "")
                        .put("base_ref", "origin/master").put("base_commit", "b".repeat(40))
                        .put("created_at", "2026-07-28T12:00:00Z"))
                .put("identities", identities)
                .put("owner_lease", new JSONObject().put("owner_id", "owner-1")
                        .put("lease_id", "lease-1").put("status", "active")
                        .put("lease_expires_at", "2026-07-28T12:10:00Z"))
                .put("status", new JSONObject().put("schema", "modification_status.v1")
                        .put("state", state).put("blocking_reason", "")
                        .put("request", new JSONObject().put("request_id", "request-1"))
                        .put("intent", new JSONObject().put("intent_id", "intent-1"))
                        .put("task", new JSONObject().put("task_id", "task-1"))
                        .put("run", new JSONObject().put("run_id", "run-1"))
                        .put("owner", new JSONObject().put("owner_id", "owner-1")
                                .put("lease_id", "lease-1")));
    }
}

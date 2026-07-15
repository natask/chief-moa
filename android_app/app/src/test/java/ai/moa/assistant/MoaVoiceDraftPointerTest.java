package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

public final class MoaVoiceDraftPointerTest {
    @Test
    public void exactPointerRoundTripsAcrossProcessStorage() {
        MoaVoiceDraftPointer pointer = new MoaVoiceDraftPointer("draft-1", 7L, "session-1", "branch-1");
        assertEquals(pointer, MoaVoiceDraftPointer.parsePersisted(pointer.toJson().toString()));
        assertEquals(4, pointer.toJson().length());
    }

    @Test
    public void rejectsInvalidOrContentBearingShapes() throws Exception {
        assertNull(MoaVoiceDraftPointer.parsePersisted(new JSONObject()
                .put("id", "draft-1")
                .put("revision", "7")
                .put("session_id", "session-1")
                .put("branch_id", "branch-1")));
        assertNull(MoaVoiceDraftPointer.parsePersisted(new JSONObject()
                .put("id", "draft-1")
                .put("revision", 7)
                .put("session_id", "session-1")
                .put("branch_id", "branch-1")
                .put("transcript", "must not persist")));
    }

    @Test
    public void rejectsWhitespaceControlPathLikeAndOverlongPersistedAuthority() throws Exception {
        String[] hostile = {
                " draft-1",
                "draft-1 ",
                "draft\n1",
                "../draft-1",
                "draft/1",
                "d".repeat(121)
        };
        for (String token : hostile) {
            assertNull(MoaVoiceDraftPointer.parsePersisted(pointerJson(token, "session-1", "branch-1")));
            assertNull(MoaVoiceDraftPointer.parsePersisted(pointerJson("draft-1", token, "branch-1")));
            assertNull(MoaVoiceDraftPointer.parsePersisted(pointerJson("draft-1", "session-1", token)));
            assertConstructorRejects(token, "session-1", "branch-1");
            assertConstructorRejects("draft-1", token, "branch-1");
            assertConstructorRejects("draft-1", "session-1", token);
        }

        String max = "d".repeat(120);
        assertEquals(max, new MoaVoiceDraftPointer(max, 1L, max, max).draftId);
    }

    private static JSONObject pointerJson(String id, String session, String branch) throws Exception {
        return new JSONObject()
                .put("id", id)
                .put("revision", 7L)
                .put("session_id", session)
                .put("branch_id", branch);
    }

    private static void assertConstructorRejects(String id, String session, String branch) {
        try {
            new MoaVoiceDraftPointer(id, 1L, session, branch);
            fail("Expected hostile authority to be rejected: " + id);
        } catch (IllegalArgumentException expected) {
            // Expected strict authority rejection.
        }
    }
}

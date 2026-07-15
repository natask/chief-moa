package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public final class MoaVoiceDraftAdmissionTest {
    @Test
    public void olderGatewayUsesLegacyVoice() {
        assertEquals(
                MoaVoiceDraftAdmission.Mode.LEGACY,
                MoaVoiceDraftAdmission.decide(false, "new", "session-1", "", null).mode
        );
    }

    @Test
    public void failedExplicitRootIsBlockedNotLegacyOrDefault() {
        assertEquals(
                MoaVoiceDraftAdmission.Mode.BLOCKED,
                MoaVoiceDraftAdmission.decide(true, "new", "session-1", "", null).mode
        );
        assertEquals(
                MoaVoiceDraftAdmission.Mode.BLOCKED,
                MoaVoiceDraftAdmission.decide(true, "incognito", "session-1", "", null).mode
        );
    }

    @Test
    public void resumeKeepsPersistedAuthority() {
        MoaVoiceDraftPointer pointer = new MoaVoiceDraftPointer("draft-1", 4L, "session-old", "branch-old");
        MoaVoiceDraftAdmission admission = MoaVoiceDraftAdmission.decide(
                true,
                "continue",
                "session-current",
                "default",
                pointer
        );
        assertEquals(MoaVoiceDraftAdmission.Mode.DRAFT, admission.mode);
        assertEquals("session-old", admission.sessionId);
        assertEquals("branch-old", admission.branchId);
        assertEquals(pointer, admission.resumePointer);
    }

    @Test
    public void draftAdmissionRejectsNonCanonicalSessionAndBranchWithoutAffectingLegacyFallback() {
        assertEquals(
                MoaVoiceDraftAdmission.Mode.BLOCKED,
                MoaVoiceDraftAdmission.decide(true, "continue", " session-1", "branch-1", null).mode
        );
        assertEquals(
                MoaVoiceDraftAdmission.Mode.BLOCKED,
                MoaVoiceDraftAdmission.decide(true, "continue", "session-1", "../branch", null).mode
        );
        assertEquals(
                MoaVoiceDraftAdmission.Mode.BLOCKED,
                MoaVoiceDraftAdmission.decide(true, "continue", "s".repeat(121), "branch-1", null).mode
        );
        assertEquals(
                MoaVoiceDraftAdmission.Mode.LEGACY,
                MoaVoiceDraftAdmission.decide(false, "continue", " session-1", "../branch", null).mode
        );
    }

    @Test
    public void defaultsBlankActionToContinueAndRetainsNewAuthority() {
        MoaVoiceDraftAdmission admission = MoaVoiceDraftAdmission.decide(
                true,
                null,
                "session-1",
                "branch-1",
                null
        );

        assertEquals(MoaVoiceDraftAdmission.Mode.DRAFT, admission.mode);
        assertEquals("continue", admission.contextAction);
        assertEquals("session-1", admission.sessionId);
        assertEquals("branch-1", admission.branchId);
        assertNull(admission.resumePointer);
    }

    @Test
    public void acceptsEveryCanonicalContextActionAndClassifiesBranchResolution() {
        for (String action : new String[]{"continue", "new", "fork", "incognito"}) {
            MoaVoiceDraftAdmission admission = MoaVoiceDraftAdmission.decide(
                    true,
                    action.toUpperCase(),
                    "session-1",
                    "branch-1",
                    null
            );
            assertEquals(action, MoaVoiceDraftAdmission.Mode.DRAFT, admission.mode);
            assertEquals(action, admission.contextAction);
        }

        assertTrue(MoaVoiceDraftAdmission.requiresResolvedBranch("new"));
        assertTrue(MoaVoiceDraftAdmission.requiresResolvedBranch("fork"));
        assertTrue(MoaVoiceDraftAdmission.requiresResolvedBranch("incognito"));
        assertEquals(false, MoaVoiceDraftAdmission.requiresResolvedBranch("continue"));
        assertEquals(false, MoaVoiceDraftAdmission.requiresResolvedBranch("unknown"));
        assertEquals(false, MoaVoiceDraftAdmission.requiresResolvedBranch(null));
    }

    @Test
    public void rejectsUnknownActionAndNonContinueResume() {
        assertEquals(
                MoaVoiceDraftAdmission.Mode.BLOCKED,
                MoaVoiceDraftAdmission.decide(true, "replace", "session-1", "branch-1", null).mode
        );

        MoaVoiceDraftPointer pointer = new MoaVoiceDraftPointer("draft-1", 4L, "session-old", "branch-old");
        MoaVoiceDraftAdmission admission = MoaVoiceDraftAdmission.decide(
                true,
                "fork",
                "session-current",
                "branch-current",
                pointer
        );
        assertEquals(MoaVoiceDraftAdmission.Mode.BLOCKED, admission.mode);
        assertEquals("", admission.contextAction);
        assertEquals("", admission.sessionId);
        assertEquals("", admission.branchId);
        assertNull(admission.resumePointer);

        MoaVoiceDraftAdmission resumed = MoaVoiceDraftAdmission.decide(
                true,
                "continue",
                "session-current",
                "branch-current",
                pointer
        );
        assertSame(pointer, resumed.resumePointer);
    }
}

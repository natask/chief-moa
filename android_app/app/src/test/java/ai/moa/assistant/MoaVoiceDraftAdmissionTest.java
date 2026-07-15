package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

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
}

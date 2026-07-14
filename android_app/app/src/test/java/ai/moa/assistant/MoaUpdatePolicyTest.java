package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaUpdatePolicyTest {
    @Test
    public void newerVerifiedManifestIsAvailableWithoutInstalling() throws Exception {
        MoaUpdatePolicy.Decision decision = MoaUpdatePolicy.evaluate(manifest(42L), 41L, "old", 0L);

        assertEquals(MoaUpdatePolicy.State.AVAILABLE, decision.state);
        assertTrue(decision.isAvailable());
        assertFalse(decision.rollbackAvailable);
        assertTrue(MoaUpdatePolicy.decisionMessage(decision).contains("will not download or install"));
    }

    @Test
    public void deferralAppliesOnlyToTheExactRelease() throws Exception {
        assertEquals(
                MoaUpdatePolicy.State.DEFERRED,
                MoaUpdatePolicy.evaluate(manifest(42L), 41L, "old", 42L).state
        );
        assertEquals(
                MoaUpdatePolicy.State.AVAILABLE,
                MoaUpdatePolicy.evaluate(manifest(43L), 41L, "old", 42L).state
        );
    }

    @Test
    public void sameSourceOrInstalledVersionIsCurrent() throws Exception {
        assertEquals(
                MoaUpdatePolicy.State.CURRENT,
                MoaUpdatePolicy.evaluate(manifest(42L), 41L, "release-42", 0L).state
        );
        assertEquals(
                MoaUpdatePolicy.State.CURRENT,
                MoaUpdatePolicy.evaluate(manifest(42L), 42L, "old", 0L).state
        );
    }

    @Test
    public void incompleteOrCredentialShapedMetadataCannotBecomeInstallable() throws Exception {
        JSONObject incomplete = manifest(42L);
        incomplete.remove("sha256");
        assertEquals(
                MoaUpdatePolicy.State.INVALID,
                MoaUpdatePolicy.evaluate(incomplete, 41L, "old", 0L).state
        );
    }

    private static JSONObject manifest(long versionCode) throws Exception {
        return new JSONObject()
                .put("app_id", "ai.moa.assistant")
                .put("version_code", versionCode)
                .put("version_name", "0.1." + versionCode)
                .put("git_sha", "release-" + versionCode)
                .put("size_bytes", 1024L)
                .put("sha256", "a".repeat(64))
                .put("rollback_available", false);
    }
}

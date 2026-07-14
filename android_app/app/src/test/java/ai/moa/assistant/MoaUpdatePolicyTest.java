package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
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

    @Test
    public void noRollbackObjectMeansNoRestoreOption() throws Exception {
        MoaUpdatePolicy.Decision decision = MoaUpdatePolicy.evaluate(manifest(42L), 41L, "old", 0L);
        assertFalse(decision.hasRollback());
        assertNull(decision.rollback);
        assertFalse(decision.rollbackAvailable);
    }

    @Test
    public void rollbackFlagWithoutObjectIsIgnored() throws Exception {
        JSONObject manifest = manifest(42L).put("rollback_available", true);
        // rollback_available says yes but there is no rollback object to trust.
        assertNull(MoaUpdatePolicy.evaluate(manifest, 41L, "old", 0L).rollback);
    }

    @Test
    public void verifiedLowerRollbackRequiresReinstall() throws Exception {
        JSONObject manifest = manifest(43L)
                .put("rollback_available", true)
                .put("rollback", rollback(40L, false));
        // Installed is 44; the rollback (40) is lower, so a reinstall is forced
        // even though the manifest hint said requires_reinstall=false.
        MoaUpdatePolicy.Decision decision = MoaUpdatePolicy.evaluate(manifest, 44L, "old", 0L);
        assertTrue(decision.hasRollback());
        assertTrue(decision.rollback.requiresReinstall);
        assertEquals(40L, decision.rollback.versionCode);
        assertTrue(MoaUpdatePolicy.rollbackMessage(decision.rollback).contains("uninstall"));
    }

    @Test
    public void inPlaceRollbackDoesNotRequireReinstall() throws Exception {
        JSONObject manifest = manifest(43L)
                .put("rollback_available", true)
                .put("rollback", rollback(42L, false));
        // Installed is 41; the rollback (42) is not lower, so it installs in place.
        MoaUpdatePolicy.Decision decision = MoaUpdatePolicy.evaluate(manifest, 41L, "old", 0L);
        assertTrue(decision.hasRollback());
        assertFalse(decision.rollback.requiresReinstall);
        assertFalse(MoaUpdatePolicy.rollbackMessage(decision.rollback).contains("uninstall"));
    }

    @Test
    public void explicitReinstallHintIsHonoredEvenWhenNotLower() throws Exception {
        JSONObject manifest = manifest(43L)
                .put("rollback_available", true)
                .put("rollback", rollback(42L, true));
        MoaUpdatePolicy.Decision decision = MoaUpdatePolicy.evaluate(manifest, 41L, "old", 0L);
        assertTrue(decision.rollback.requiresReinstall);
    }

    @Test
    public void malformedRollbackShaIsRejectedAsNoRollback() throws Exception {
        JSONObject bad = rollback(40L, true).put("sha256", "z".repeat(64));
        JSONObject manifest = manifest(43L)
                .put("rollback_available", true)
                .put("rollback", bad);
        assertNull(MoaUpdatePolicy.evaluate(manifest, 44L, "old", 0L).rollback);
    }

    @Test
    public void rollbackWithNonHttpUrlIsRejected() throws Exception {
        JSONObject bad = rollback(40L, true).put("download_url", "file:///data/evil.apk");
        JSONObject manifest = manifest(43L)
                .put("rollback_available", true)
                .put("rollback", bad);
        assertNull(MoaUpdatePolicy.evaluate(manifest, 44L, "old", 0L).rollback);
    }

    @Test
    public void rollbackWithMissingSizeIsRejected() throws Exception {
        JSONObject bad = rollback(40L, true);
        bad.remove("size_bytes");
        JSONObject manifest = manifest(43L)
                .put("rollback_available", true)
                .put("rollback", bad);
        assertNull(MoaUpdatePolicy.evaluate(manifest, 44L, "old", 0L).rollback);
    }

    @Test
    public void rollbackWithBlankReleaseIdIsRejected() throws Exception {
        JSONObject bad = rollback(40L, true).put("release_id", "  ");
        JSONObject manifest = manifest(43L)
                .put("rollback_available", true)
                .put("rollback", bad);
        assertNull(MoaUpdatePolicy.evaluate(manifest, 44L, "old", 0L).rollback);
    }

    @Test
    public void rollbackIsOfferedEvenWhenInstalledIsAlreadyCurrent() throws Exception {
        JSONObject manifest = manifest(42L)
                .put("rollback_available", true)
                .put("rollback", rollback(40L, true));
        // Installed == manifest version (CURRENT), user still may restore back.
        MoaUpdatePolicy.Decision decision = MoaUpdatePolicy.evaluate(manifest, 42L, "old", 0L);
        assertEquals(MoaUpdatePolicy.State.CURRENT, decision.state);
        assertTrue(decision.hasRollback());
        assertTrue(decision.rollback.requiresReinstall);
    }

    private static JSONObject rollback(long versionCode, boolean requiresReinstall) throws Exception {
        return new JSONObject()
                .put("release_id", "rel-" + versionCode)
                .put("version_code", versionCode)
                .put("version_name", "0.1." + versionCode)
                .put("download_url", "https://api.example.test/v1/android/updates/releases/rel-" + versionCode + ".apk")
                .put("sha256", "b".repeat(64))
                .put("size_bytes", 2048L)
                .put("requires_reinstall", requiresReinstall);
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

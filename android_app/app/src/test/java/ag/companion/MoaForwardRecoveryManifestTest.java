package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

public final class MoaForwardRecoveryManifestTest {
    private static final String INSTALLED_SHA = "1".repeat(64);
    private static final String TARGET_SHA = "2".repeat(64);
    private static final String RECOVERY_SHA = "3".repeat(64);
    private static final String SIGNER_SHA = "4".repeat(64);
    private static final String TARGET_COMMIT = "a".repeat(40);
    private static final String BUILDER_COMMIT = "b".repeat(40);

    @Test
    public void selectsExactForwardRecoveryWithDistinctBuilderAndTargetSource() throws Exception {
        MoaForwardRecoveryManifest recovery = MoaForwardRecoveryManifest.recommended(
                manifest(), "https://api.example.test", "phone-1", 20L, INSTALLED_SHA);

        assertEquals("forward-21", recovery.recoveryId);
        assertEquals("stable-release", recovery.targetReleaseId);
        assertEquals("installed-release", recovery.predecessorReleaseId);
        assertEquals(21L, recovery.artifactVersionCode);
        assertEquals(SIGNER_SHA, recovery.artifactSignerSha256);
        assertEquals("https://api.example.test/v1/release-recovery/artifacts/forward-21.apk",
                recovery.downloadUrl);
    }

    @Test
    public void absentRecommendationIsHonestlyUnavailable() throws Exception {
        JSONObject value = manifest().put("recommended_recovery_id", JSONObject.NULL)
                .put("recoveries", new JSONArray());

        assertNull(MoaForwardRecoveryManifest.recommended(
                value, "https://api.example.test", "phone-1", 20L, INSTALLED_SHA));
    }

    @Test
    public void staleStableTargetFailsClosed() throws Exception {
        JSONObject value = manifest();
        value.getJSONArray("recoveries").getJSONObject(0)
                .getJSONObject("target").put("release_id", "old-stable");

        assertThrows(IllegalArgumentException.class, () ->
                MoaForwardRecoveryManifest.recommended(
                        value, "https://api.example.test", "phone-1", 20L, INSTALLED_SHA));
    }

    @Test
    public void predecessorMustBeTheActuallyInstalledBytes() throws Exception {
        JSONObject value = manifest();
        value.getJSONArray("recoveries").getJSONObject(0)
                .getJSONObject("predecessor").put("artifact_sha256", "9".repeat(64));

        assertThrows(IllegalArgumentException.class, () ->
                MoaForwardRecoveryManifest.recommended(
                        value, "https://api.example.test", "phone-1", 20L, INSTALLED_SHA));
    }

    @Test
    public void sameOrLowerVersionAndForeignArtifactUrlFailClosed() throws Exception {
        JSONObject lower = manifest();
        lower.getJSONArray("recoveries").getJSONObject(0)
                .getJSONObject("artifact").put("version_code", 20L);
        assertThrows(IllegalArgumentException.class, () ->
                MoaForwardRecoveryManifest.recommended(
                        lower, "https://api.example.test", "phone-1", 20L, INSTALLED_SHA));

        JSONObject foreign = manifest();
        foreign.getJSONArray("recoveries").getJSONObject(0).getJSONObject("artifact")
                .put("download_url", "https://attacker.test/forward-21.apk");
        assertThrows(IllegalArgumentException.class, () ->
                MoaForwardRecoveryManifest.recommended(
                        foreign, "https://api.example.test", "phone-1", 20L, INSTALLED_SHA));
    }

    @Test
    public void staleParentAndMismatchedArtifactReleaseFailClosed() throws Exception {
        JSONObject staleParent = manifest();
        staleParent.getJSONArray("recoveries").getJSONObject(0).getJSONObject("parents")
                .getJSONObject("stable").put("sequence", 3L);
        assertThrows(IllegalArgumentException.class, () ->
                MoaForwardRecoveryManifest.recommended(staleParent,
                        "https://api.example.test", "phone-1", 20L, INSTALLED_SHA));

        JSONObject mismatchedId = manifest();
        mismatchedId.getJSONArray("recoveries").getJSONObject(0).getJSONObject("artifact")
                .put("release_id", "different-recovery");
        assertThrows(IllegalArgumentException.class, () ->
                MoaForwardRecoveryManifest.recommended(mismatchedId,
                        "https://api.example.test", "phone-1", 20L, INSTALLED_SHA));
    }

    static JSONObject manifest() throws Exception {
        JSONObject stableArtifact = new JSONObject().put("surface", "android")
                .put("app_id", "ag.companion").put("version_code", 10L)
                .put("version_name", "1.0.0").put("sha256", TARGET_SHA)
                .put("size_bytes", 100L).put("download_url", "https://api.example.test/stable.apk");
        JSONObject stable = new JSONObject().put("channel", "stable")
                .put("bundle_id", "stable-bundle").put("release_id", "stable-release")
                .put("source_ref", TARGET_COMMIT)
                .put("compatibility", new JSONObject().put("eligible", true))
                .put("artifact", stableArtifact);
        JSONObject target = new JSONObject().put("channel", "stable")
                .put("bundle_id", "stable-bundle").put("release_id", "stable-release")
                .put("source_commit", TARGET_COMMIT).put("artifact_sha256", TARGET_SHA)
                .put("version_code", 10L).put("sequence", 4L);
        JSONObject predecessor = new JSONObject().put("bundle_id", "installed-bundle")
                .put("release_id", "installed-release").put("source_commit", "c".repeat(40))
                .put("artifact_sha256", INSTALLED_SHA).put("version_code", 20L);
        JSONObject artifact = new JSONObject().put("release_id", "forward-21")
                .put("version_code", 21L).put("version_name", "1.0.0-recovery.21")
                .put("package_name", "ag.companion").put("sha256", RECOVERY_SHA)
                .put("size_bytes", 200L).put("signer_sha256", SIGNER_SHA)
                .put("source_commit", TARGET_COMMIT).put("built_at", "2026-08-14T00:00:00Z")
                .put("download_url",
                        "https://api.example.test/v1/release-recovery/artifacts/forward-21.apk");
        JSONObject parents = new JSONObject()
                .put("stable", new JSONObject().put("bundle_id", "stable-bundle")
                        .put("release_id", "stable-release").put("sequence", 4L))
                .put("trial", new JSONObject().put("bundle_id", "installed-bundle")
                        .put("release_id", "installed-release").put("sequence", 8L));
        JSONObject provenance = new JSONObject().put("builder_commit", BUILDER_COMMIT)
                .put("target_bundle_id", "stable-bundle")
                .put("target_release_id", "stable-release")
                .put("target_source_commit", TARGET_COMMIT)
                .put("predecessor_release_id", "installed-release")
                .put("parent_stable_bundle_id", "stable-bundle")
                .put("parent_trial_bundle_id", "installed-bundle")
                .put("provenance_sha256", "5".repeat(64));
        JSONObject recovery = new JSONObject()
                .put("schema_version", "moa-forward-recovery-manifest/v1")
                .put("recovery_id", "forward-21").put("application_id", "chief-moa")
                .put("device_id", "phone-1").put("target", target)
                .put("predecessor", predecessor).put("parents", parents)
                .put("artifact", artifact).put("provenance", provenance);
        return new JSONObject().put("schema_version", 1).put("application_id", "chief-moa")
                .put("device_id", "phone-1")
                .put("channels", new JSONObject().put("stable", new JSONObject()
                        .put("sequence", 4L).put("bundle", new JSONObject()
                                .put("bundle_id", "stable-bundle")
                                .put("release_id", "stable-release")))
                        .put("preview", JSONObject.NULL))
                .put("candidates", new JSONArray().put(stable))
                .put("recoveries", new JSONArray().put(recovery))
                .put("recommended_recovery_id", "forward-21");
    }
}

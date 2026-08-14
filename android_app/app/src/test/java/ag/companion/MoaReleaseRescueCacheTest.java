package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class MoaReleaseRescueCacheTest {
    @Test
    public void exactStableTrialInstalledAndSignerMetadataRoundTrips() throws Exception {
        MoaReleaseRescueCache.Snapshot source = snapshot();

        MoaReleaseRescueCache.Snapshot restored =
                MoaReleaseRescueCache.parse(MoaReleaseRescueCache.encode(source).toString());

        assertNotNull(restored);
        assertEquals("android_device", restored.deviceId);
        assertEquals("stable-release", restored.stable.releaseId);
        assertEquals("stable-bundle", restored.stable.bundleId);
        assertEquals("b".repeat(64), restored.stable.sha256);
        assertEquals("trial-release", restored.trial.releaseId);
        assertEquals(List.of("d".repeat(64)), restored.signerDigests);
        assertEquals("a".repeat(64), restored.installedSha256);
    }

    @Test
    public void alteredCachedMetadataFailsClosed() throws Exception {
        JSONObject envelope = MoaReleaseRescueCache.encode(snapshot());
        envelope.getJSONObject("stable").put("release_id", "forged-release");

        assertThrows(IllegalArgumentException.class,
                () -> MoaReleaseRescueCache.parse(envelope.toString()));
    }

    @Test
    public void malformedSignerOrArtifactNeverParses() throws Exception {
        JSONObject envelope = MoaReleaseRescueCache.encode(snapshot());
        envelope.getJSONArray("continuity_signers").put(0, "not-a-signer");
        envelope.remove("integrity_sha256");
        envelope.put("integrity_sha256", "0".repeat(64));

        assertThrows(IllegalArgumentException.class,
                () -> MoaReleaseRescueCache.parse(envelope.toString()));
    }

    @Test
    public void validatedForwardRecoverySurvivesRestartAndBindsInstalledIdentity() throws Exception {
        MoaForwardRecoveryManifest recovery = MoaForwardRecoveryManifest.recommended(
                MoaForwardRecoveryManifestTest.manifest(), "https://api.example.test",
                "phone-1", 20L, "1".repeat(64));
        MoaReleaseRescueCache.Snapshot source = new MoaReleaseRescueCache.Snapshot(
                "https://api.example.test", "phone-1", "2.0.0", 20L,
                "1".repeat(64), List.of("4".repeat(64)), null, null, 1234L, recovery);

        MoaReleaseRescueCache.Snapshot restored = MoaReleaseRescueCache.parse(
                MoaReleaseRescueCache.encode(source).toString());

        assertNotNull(restored.forwardRecovery);
        assertEquals("forward-21", restored.forwardRecovery.recoveryId);
        assertTrue(restored.forwardRecovery.matchesInstalled(
                20L, "1".repeat(64), java.util.Set.of("4".repeat(64))));
        org.junit.Assert.assertFalse(restored.forwardRecovery.matchesInstalled(
                20L, "9".repeat(64), java.util.Set.of("4".repeat(64))));
        org.junit.Assert.assertFalse(restored.forwardRecovery.matchesInstalled(
                19L, "1".repeat(64), java.util.Set.of("4".repeat(64))));
        org.junit.Assert.assertFalse(restored.forwardRecovery.matchesInstalled(
                20L, "1".repeat(64), java.util.Set.of("8".repeat(64))));
    }

    private static MoaReleaseRescueCache.Snapshot snapshot() {
        return new MoaReleaseRescueCache.Snapshot(
                "https://api.example.test", "android_device", "1.2.3", 123L,
                "a".repeat(64), List.of("d".repeat(64)),
                entry("stable", "stable-release", "stable-bundle", 124L, "b"),
                entry("preview", "trial-release", "trial-bundle", 125L, "c"), 9876L);
    }

    private static MoaReleaseRescueCache.Entry entry(
            String channel, String release, String bundle, long code, String sha) {
        return new MoaReleaseRescueCache.Entry(channel, release, bundle, "1.2." + code,
                code, sha.repeat(64), 2048L,
                "https://api.example.test/releases/" + release + ".apk");
    }
}

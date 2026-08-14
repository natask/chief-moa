package ag.companion;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;

import static org.junit.Assert.assertEquals;

public final class MoaReleaseRescuePolicyTest {
    @Test
    public void exactInstalledStableNeedsNoAction() {
        assertEquals(MoaReleaseRescuePolicy.Action.INSTALLED,
                MoaReleaseRescuePolicy.action(entry(12L, 4L), 11L, "a".repeat(64), null));
    }

    @Test
    public void lowerVersionRequiresForwardRecoveryAndNeverOffersUninstall() {
        MoaReleaseRescuePolicy.Action action =
                MoaReleaseRescuePolicy.action(entry(10L, 4L), 11L, "b".repeat(64), null);

        assertEquals(MoaReleaseRescuePolicy.Action.FORWARD_BUILD_REQUIRED, action);
        assertEquals("Forward recovery build required", MoaReleaseRescuePolicy.label(action));
    }

    @Test
    public void cachedBytesAreOnlyAReviewCandidateUntilFullVerification() throws Exception {
        File apk = File.createTempFile("ag-rescue", ".apk");
        try (FileOutputStream output = new FileOutputStream(apk)) {
            output.write(new byte[]{1, 2, 3, 4});
        }

        assertEquals(MoaReleaseRescuePolicy.Action.INSTALL_CACHED,
                MoaReleaseRescuePolicy.action(entry(12L, 4L), 11L, "b".repeat(64), apk));
        assertEquals(MoaReleaseRescuePolicy.Action.DOWNLOAD_AND_INSTALL,
                MoaReleaseRescuePolicy.action(entry(12L, 5L), 11L, "b".repeat(64), apk));
        apk.delete();
    }

    @Test
    public void missingMetadataCannotClaimRestore() {
        assertEquals(MoaReleaseRescuePolicy.Action.UNAVAILABLE,
                MoaReleaseRescuePolicy.action(null, 11L, "a".repeat(64), null));
    }

    private static MoaReleaseRescueCache.Entry entry(long code, long size) {
        return new MoaReleaseRescueCache.Entry("stable", "release", "bundle", "1.2.3",
                code, "a".repeat(64), size, "https://api.example.test/release.apk");
    }
}

package ag.companion;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public final class MoaRecoveryInstallContractTest {
    @Test
    public void inPlaceInstallerHandoffPreservesEnrollmentAndNeverUninstalls() {
        Context context = RuntimeEnvironment.getApplication();
        MoaDeviceCredentialStore credentials = new MoaDeviceCredentialStore(context);
        credentials.saveEnrollmentCredential("https://api.example.test", "phone-1",
                "ag_dev_v1." + "a".repeat(43), true, "owner-1");

        Intent intent = MoaRecoveryInstallContract.review(Uri.parse(
                "content://ag.companion.apkprovider/ota/ag-update.apk"));

        assertEquals(Intent.ACTION_VIEW, intent.getAction());
        assertFalse(Intent.ACTION_DELETE.equals(intent.getAction()));
        assertTrue(MoaRecoveryInstallContract.preservesAppPrivateData());
        assertFalse(MoaRecoveryInstallContract.permitsSilentUninstall());
        MoaDeviceCredentialStore.EnrollmentCredential retained =
                credentials.loadEnrollmentCredential("https://api.example.test", "phone-1");
        assertNotNull(retained);
        assertTrue(retained.verified);
        assertEquals("owner-1", retained.accountId);
    }

    @Test
    public void cachedRecoveryIsBoundToItsOriginAndDevice() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        MoaForwardRecoveryManifest recovery = MoaForwardRecoveryManifest.recommended(
                MoaForwardRecoveryManifestTest.manifest(), "https://api.example.test",
                "phone-1", 20L, "1".repeat(64));
        MoaReleaseRescueCache.Snapshot snapshot = new MoaReleaseRescueCache.Snapshot(
                "https://api.example.test", "phone-1", "2.0.0", 20L,
                "1".repeat(64), java.util.List.of("4".repeat(64)),
                null, null, 1234L, recovery);
        MoaReleaseRescueCache cache = new MoaReleaseRescueCache(context);
        cache.save(snapshot);

        assertNotNull(cache.load("https://api.example.test", "phone-1"));
        assertNull(cache.load("https://other.example.test", "phone-1"));
        assertNull(cache.load("https://api.example.test", "phone-2"));
    }
}

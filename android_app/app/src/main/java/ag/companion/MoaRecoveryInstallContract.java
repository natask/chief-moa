package ag.companion;

import android.content.Intent;
import android.net.Uri;

/** System-installer handoff for in-place recovery. This contract never emits uninstall. */
final class MoaRecoveryInstallContract {
    private MoaRecoveryInstallContract() { }

    static Intent review(Uri apk) {
        if (apk == null || !"content".equals(apk.getScheme())) {
            throw new IllegalArgumentException("verified APK content URI is required");
        }
        return new Intent(Intent.ACTION_VIEW)
                .setDataAndType(apk, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    static boolean preservesAppPrivateData() {
        return true;
    }

    static boolean permitsSilentUninstall() {
        return false;
    }
}

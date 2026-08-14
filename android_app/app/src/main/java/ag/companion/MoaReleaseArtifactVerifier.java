package ag.companion;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import java.io.File;
import java.util.Set;

/** Exact-byte, package, version, and continuity-signer checks shared by OTA and rescue. */
final class MoaReleaseArtifactVerifier {
    private MoaReleaseArtifactVerifier() { }

    static void verify(
            PackageManager packages, String packageName, File apk,
            String expectedAppId, long expectedVersionCode,
            String expectedSha256, long expectedSizeBytes) throws Exception {
        if (!packageName.equals(expectedAppId)) {
            throw new IllegalStateException("APK application id mismatch");
        }
        if (expectedSizeBytes <= 0L || apk == null || apk.length() != expectedSizeBytes) {
            throw new IllegalStateException("APK size mismatch");
        }
        String digest = safe(expectedSha256).toLowerCase();
        if (!digest.matches("[a-f0-9]{64}")
                || !digest.equals(MoaUpdateArtifact.sha256Hex(apk))) {
            throw new IllegalStateException("APK checksum mismatch");
        }
        PackageInfo archive = MoaUpdateArtifact.packageInfoForArchive(packages, apk);
        if (archive == null || !packageName.equals(archive.packageName)) {
            throw new IllegalStateException("APK package mismatch");
        }
        long archiveVersion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? archive.getLongVersionCode() : archive.versionCode;
        if (expectedVersionCode <= 0L || archiveVersion != expectedVersionCode) {
            throw new IllegalStateException("APK version mismatch");
        }
        PackageInfo installed = packages.getPackageInfo(
                packageName, MoaUpdateArtifact.signatureFlags());
        if (!MoaUpdateArtifact.signatureDigests(installed).equals(
                MoaUpdateArtifact.signatureDigests(archive))) {
            throw new IllegalStateException("APK signer mismatch");
        }
    }

    static Set<String> installedSignerDigests(
            PackageManager packages, String packageName) throws Exception {
        return MoaUpdateArtifact.signatureDigests(packages.getPackageInfo(
                packageName, MoaUpdateArtifact.signatureFlags()));
    }

    static void verifyForwardRecovery(
            PackageManager packages, String packageName, File apk,
            long expectedVersionCode, String expectedSha256, long expectedSizeBytes,
            String expectedSignerSha256) throws Exception {
        verify(packages, packageName, apk, packageName, expectedVersionCode,
                expectedSha256, expectedSizeBytes);
        String signer = safe(expectedSignerSha256).toLowerCase();
        if (!declaresInstalledSigner(installedSignerDigests(packages, packageName), signer)) {
            throw new IllegalStateException("APK continuity signer declaration mismatch");
        }
    }

    static boolean declaresInstalledSigner(Set<String> installedSigners, String declaredSigner) {
        String signer = safe(declaredSigner).toLowerCase();
        return signer.matches("[a-f0-9]{64}") && installedSigners != null
                && installedSigners.contains(signer);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

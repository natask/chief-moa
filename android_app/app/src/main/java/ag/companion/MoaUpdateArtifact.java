package ag.companion;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/**
 * Identity and integrity of an OTA update artifact.
 *
 * Android accepts an update only when the application id and the signer both
 * match what is already installed, so deciding whether a downloaded APK may be
 * offered is a question about bytes and certificates, not about screens. It
 * lived in {@link MainActivity} only because that is where the update button
 * happened to be.
 *
 * The pure parts -- hashing, hex encoding, endpoint joining -- are static and
 * unit-testable without a device. The parts that genuinely need a
 * PackageManager stay parameterised by one so the caller supplies it rather
 * than this class reaching for an Activity.
 */
final class MoaUpdateArtifact {

    private MoaUpdateArtifact() {
    }

    /** GET_SIGNING_CERTIFICATES replaced GET_SIGNATURES in API 28. */
    static int signatureFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
    }

    static PackageInfo packageInfoForArchive(PackageManager packages, File apk) {
        return packages.getPackageArchiveInfo(apk.getAbsolutePath(), signatureFlags());
    }

    /**
     * SHA-256 of every signer on the package.
     *
     * An unsigned package is rejected outright rather than treated as matching
     * nothing: a missing signer is a broken artifact, not a benign mismatch.
     */
    static Set<String> signatureDigests(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            signatures = info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) {
            throw new IllegalStateException("APK signer missing");
        }
        Set<String> digests = new HashSet<>();
        for (Signature signature : signatures) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digests.add(hex(digest.digest(signature.toByteArray())));
        }
        return digests;
    }

    static File updateApkFile(File cacheDir) {
        File dir = new File(cacheDir, "updates");
        dir.mkdirs();
        return new File(dir, MoaApkProvider.APK_NAME);
    }

    static long currentVersionCode(PackageManager packages, String packageName) throws Exception {
        PackageInfo info = packages.getPackageInfo(packageName, 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.getLongVersionCode();
        }
        return info.versionCode;
    }

    static String currentVersionName(PackageManager packages, String packageName) throws Exception {
        PackageInfo info = packages.getPackageInfo(packageName, 0);
        return info.versionName == null ? "" : info.versionName;
    }

    static String sha256Hex(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32 * 1024];
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(buffer)) >= 0) {
                digest.update(buffer, 0, read);
            }
        }
        return hex(digest.digest());
    }

    /**
     * Join a gateway origin and a path without doubling the separator.
     *
     * A trailing slash on the configured gateway URL is common enough that
     * silently producing "//v1/..." would be a real bug.
     */
    static String gatewayEndpoint(String gatewayUrl, String path) {
        String base = gatewayUrl == null ? "" : gatewayUrl.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + path;
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            out.append(String.format("%02x", value & 0xff));
        }
        return out.toString();
    }
}

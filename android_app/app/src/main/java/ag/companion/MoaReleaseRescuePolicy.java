package ag.companion;

import java.io.File;

/** Pure fail-closed action policy for the native release rescue surface. */
final class MoaReleaseRescuePolicy {
    enum Action { INSTALLED, INSTALL_CACHED, DOWNLOAD_AND_INSTALL, FORWARD_BUILD_REQUIRED, UNAVAILABLE }

    private MoaReleaseRescuePolicy() { }

    static Action action(
            MoaReleaseRescueCache.Entry stable, long installedVersionCode,
            String installedSha256, File cachedApk) {
        if (stable == null) return Action.UNAVAILABLE;
        if (stable.sha256.equalsIgnoreCase(safe(installedSha256))) return Action.INSTALLED;
        if (stable.versionCode < installedVersionCode) return Action.FORWARD_BUILD_REQUIRED;
        if (cachedApk != null && cachedApk.isFile()
                && cachedApk.length() == stable.sizeBytes) return Action.INSTALL_CACHED;
        return Action.DOWNLOAD_AND_INSTALL;
    }

    static String label(Action action) {
        switch (action) {
            case INSTALLED: return "Stable is installed";
            case INSTALL_CACHED: return "Verify cached stable and review install";
            case DOWNLOAD_AND_INSTALL: return "Download stable and review install";
            case FORWARD_BUILD_REQUIRED: return "Forward recovery build required";
            default: return "Stable restore unavailable";
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

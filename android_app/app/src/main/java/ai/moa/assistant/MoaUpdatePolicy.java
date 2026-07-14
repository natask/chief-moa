package ai.moa.assistant;

import org.json.JSONObject;

import java.util.Locale;

/** Pure update availability and presentation policy. Never downloads or installs. */
final class MoaUpdatePolicy {
    private static final int MAX_VERSION_NAME_CHARS = 64;

    enum State {
        CURRENT,
        AVAILABLE,
        DEFERRED,
        INVALID
    }

    static final class Decision {
        final State state;
        final long versionCode;
        final String versionName;
        final boolean rollbackAvailable;
        final String reason;

        Decision(State state, long versionCode, String versionName, boolean rollbackAvailable, String reason) {
            this.state = state;
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.rollbackAvailable = rollbackAvailable;
            this.reason = reason;
        }

        boolean isAvailable() {
            return state == State.AVAILABLE || state == State.DEFERRED;
        }
    }

    private MoaUpdatePolicy() {
    }

    static Decision evaluate(
            JSONObject manifest,
            long currentVersionCode,
            String currentGitSha,
            long deferredVersionCode
    ) {
        if (manifest == null) {
            return new Decision(State.INVALID, 0L, "", false, "manifest_missing");
        }
        long remoteVersionCode = manifest.optLong("version_code", 0L);
        String versionName = boundedVersionName(
                manifest.optString("version_name", String.valueOf(remoteVersionCode))
        );
        String appId = safe(manifest.optString("app_id", ""));
        String sha256 = safe(manifest.optString("sha256", "")).toLowerCase(Locale.US);
        long sizeBytes = manifest.optLong("size_bytes", 0L);
        if (remoteVersionCode <= 0L
                || versionName.isEmpty()
                || !"ai.moa.assistant".equals(appId)
                || sizeBytes <= 0L
                || !sha256.matches("[a-f0-9]{64}")) {
            return new Decision(State.INVALID, remoteVersionCode, versionName, false, "manifest_unverified");
        }

        String remoteGitSha = safe(manifest.optString("git_sha", ""));
        String installedGitSha = safe(currentGitSha);
        boolean sameSource = !remoteGitSha.isEmpty() && remoteGitSha.equals(installedGitSha);
        boolean rollbackAvailable = manifest.optBoolean("rollback_available", false);
        if (sameSource || remoteVersionCode <= currentVersionCode) {
            return new Decision(State.CURRENT, remoteVersionCode, versionName, rollbackAvailable, "installed_is_current");
        }
        if (remoteVersionCode == deferredVersionCode) {
            return new Decision(State.DEFERRED, remoteVersionCode, versionName, rollbackAvailable, "user_deferred");
        }
        return new Decision(State.AVAILABLE, remoteVersionCode, versionName, rollbackAvailable, "newer_verified_metadata");
    }

    static String decisionMessage(Decision decision) {
        String rollback = decision.rollbackAvailable
                ? "A signed recovery release is available if this version does not work well."
                : "A one-tap rollback is not available for this release. Android normally blocks installing a lower version over a newer one.";
        return "Version " + decision.versionName + " is available.\n\n"
                + "A.G. will not download or install it unless you choose Install. "
                + "Android will ask you to confirm again before installation.\n\n"
                + rollback;
    }

    private static String boundedVersionName(String value) {
        String clean = safe(value).replaceAll("[\\p{Cntrl}]", "");
        return clean.length() <= MAX_VERSION_NAME_CHARS
                ? clean
                : clean.substring(0, MAX_VERSION_NAME_CHARS);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

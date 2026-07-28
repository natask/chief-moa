package ai.moa.assistant;

import org.json.JSONObject;

import java.util.Locale;

/** Pure update availability and presentation policy. Never downloads or installs. */
final class MoaUpdatePolicy {
    private static final int MAX_VERSION_NAME_CHARS = 64;
    private static final int MAX_RELEASE_ID_CHARS = 128;
    private static final int MAX_DOWNLOAD_URL_CHARS = 512;

    enum State {
        CURRENT,
        AVAILABLE,
        DEFERRED,
        INVALID
    }

    /**
     * A verified previous release the user may restore. Present only when the
     * manifest carried a well-formed, self-consistent rollback object. Parsing
     * is as strict as the main manifest: the rollback object has no app_id, so
     * we validate the sha256 shape, positive version fields, positive size, a
     * bounded release id, and an http(s) download URL instead.
     */
    static final class RollbackOption {
        final String releaseId;
        final long versionCode;
        final String versionName;
        final String downloadUrl;
        final String sha256;
        final long sizeBytes;
        /**
         * True when Android cannot install this artifact in place because it is
         * an older version_code than what is installed. The user must uninstall
         * the current build first. Computed from the manifest hint OR from the
         * version_code relationship, whichever demands a reinstall.
         */
        final boolean requiresReinstall;

        RollbackOption(
                String releaseId,
                long versionCode,
                String versionName,
                String downloadUrl,
                String sha256,
                long sizeBytes,
                boolean requiresReinstall
        ) {
            this.releaseId = releaseId;
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.downloadUrl = downloadUrl;
            this.sha256 = sha256;
            this.sizeBytes = sizeBytes;
            this.requiresReinstall = requiresReinstall;
        }
    }

    static final class Decision {
        final State state;
        final long versionCode;
        final String versionName;
        final boolean rollbackAvailable;
        final RollbackOption rollback;
        final String reason;

        Decision(
                State state,
                long versionCode,
                String versionName,
                RollbackOption rollback,
                String reason
        ) {
            this.state = state;
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.rollback = rollback;
            this.rollbackAvailable = rollback != null;
            this.reason = reason;
        }

        boolean isAvailable() {
            return state == State.AVAILABLE || state == State.DEFERRED;
        }

        boolean hasRollback() {
            return rollback != null;
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
            return new Decision(State.INVALID, 0L, "", null, "manifest_missing");
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
            return new Decision(State.INVALID, remoteVersionCode, versionName, null, "manifest_unverified");
        }

        RollbackOption rollback = parseRollback(manifest, currentVersionCode);

        String remoteGitSha = safe(manifest.optString("git_sha", ""));
        String installedGitSha = safe(currentGitSha);
        boolean sameSource = !remoteGitSha.isEmpty() && remoteGitSha.equals(installedGitSha);
        if (sameSource || remoteVersionCode <= currentVersionCode) {
            return new Decision(State.CURRENT, remoteVersionCode, versionName, rollback, "installed_is_current");
        }
        if (remoteVersionCode == deferredVersionCode) {
            return new Decision(State.DEFERRED, remoteVersionCode, versionName, rollback, "user_deferred");
        }
        return new Decision(State.AVAILABLE, remoteVersionCode, versionName, rollback, "newer_verified_metadata");
    }

    /**
     * Parse and validate the optional rollback object. Returns null when the
     * manifest does not offer a rollback or when the offered rollback fails any
     * validation check. A rejected rollback is treated as "no rollback" rather
     * than surfacing a broken restore action to the user.
     */
    private static RollbackOption parseRollback(JSONObject manifest, long currentVersionCode) {
        if (!manifest.optBoolean("rollback_available", false)) {
            return null;
        }
        JSONObject rollback = manifest.optJSONObject("rollback");
        if (rollback == null) {
            return null;
        }
        long versionCode = rollback.optLong("version_code", 0L);
        String versionName = boundedVersionName(
                rollback.optString("version_name", String.valueOf(versionCode))
        );
        String releaseId = boundedField(rollback.optString("release_id", ""), MAX_RELEASE_ID_CHARS);
        String downloadUrl = boundedField(rollback.optString("download_url", ""), MAX_DOWNLOAD_URL_CHARS);
        String sha256 = safe(rollback.optString("sha256", "")).toLowerCase(Locale.US);
        long sizeBytes = rollback.optLong("size_bytes", 0L);
        if (versionCode <= 0L
                || versionName.isEmpty()
                || releaseId.isEmpty()
                || !releaseId.matches("[A-Za-z0-9._-]+")
                || downloadUrl.isEmpty()
                || !isHttpUrl(downloadUrl)
                || sizeBytes <= 0L
                || !sha256.matches("[a-f0-9]{64}")) {
            return null;
        }
        // Android refuses an in-place install of a lower version_code, so a
        // reinstall is required whenever the artifact is older than what is
        // installed, regardless of the server hint. Honor an explicit hint too.
        boolean requiresReinstall = rollback.optBoolean("requires_reinstall", false)
                || versionCode < currentVersionCode;
        return new RollbackOption(
                releaseId,
                versionCode,
                versionName,
                downloadUrl,
                sha256,
                sizeBytes,
                requiresReinstall
        );
    }

    static String decisionMessage(Decision decision) {
        String rollback = decision.rollbackAvailable
                ? "A signed recovery release is available if this version does not work well."
                : "A one-tap rollback is not available for this release. Android normally blocks installing a lower version over a newer one.";
        return "Version " + decision.versionName + " is available.\n\n"
                + "AG will not download or install it unless you choose Install. "
                + "Android will ask you to confirm again before installation.\n\n"
                + rollback;
    }

    /**
     * Consent-first copy for the "Restore previous version" action. Plain
     * language, matches decisionMessage()'s tone, and never implies anything is
     * automatic.
     */
    static String rollbackMessage(RollbackOption rollback) {
        if (rollback == null) {
            return "";
        }
        String base = "Restore version " + rollback.versionName + "?\n\n"
                + "AG will not download or install anything unless you confirm each step. "
                + "Android will ask you again before installation.\n\n";
        if (rollback.requiresReinstall) {
            return base
                    + "Because this is an older version, Android will not install it over the "
                    + "current one. You'll be sent to the system screen to uninstall the current "
                    + "version first, then AG can download and install version "
                    + rollback.versionName + ". Uninstalling can remove this app's local settings and data.";
        }
        return base
                + "AG will download the signed version " + rollback.versionName
                + " and hand it to Android's installer for you to confirm.";
    }

    private static String boundedVersionName(String value) {
        String clean = safe(value).replaceAll("[\\p{Cntrl}]", "");
        return clean.length() <= MAX_VERSION_NAME_CHARS
                ? clean
                : clean.substring(0, MAX_VERSION_NAME_CHARS);
    }

    private static String boundedField(String value, int maxChars) {
        String clean = safe(value).replaceAll("[\\p{Cntrl}]", "");
        return clean.length() <= maxChars ? clean : clean.substring(0, maxChars);
    }

    private static boolean isHttpUrl(String value) {
        String lower = value.toLowerCase(Locale.US);
        return lower.startsWith("https://") || lower.startsWith("http://");
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

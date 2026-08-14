package ag.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** App-private, origin/device-bound cache of exact release recovery metadata. */
final class MoaReleaseRescueCache {
    private static final String PREFS = "moa_release_rescue";
    private static final String KEY_ENVELOPE = "release_envelope";
    private final SharedPreferences preferences;

    MoaReleaseRescueCache(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized Snapshot load(String origin, String deviceId) {
        try {
            Snapshot snapshot = parse(preferences.getString(KEY_ENVELOPE, ""));
            return snapshot != null && safe(origin).equals(snapshot.origin)
                    && safe(deviceId).equals(snapshot.deviceId) ? snapshot : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    synchronized void save(Snapshot snapshot) throws Exception {
        String envelope = encode(snapshot).toString();
        if (!preferences.edit().putString(KEY_ENVELOPE, envelope).commit()) {
            throw new IllegalStateException("release rescue metadata could not be cached");
        }
    }

    static Snapshot fromView(
            String origin, String deviceId, String installedVersion,
            long installedVersionCode, String installedSha256, List<String> signerDigests,
            MoaReleaseSelectionPolicy.View view, long capturedAt) {
        return new Snapshot(safe(origin), safe(deviceId), safe(installedVersion),
                installedVersionCode, normalizedSha(installedSha256), signerDigests,
                Entry.fromCandidate(view == null ? null : view.stable),
                Entry.fromCandidate(view == null ? null : view.preview), capturedAt, null);
    }

    static JSONObject encode(Snapshot snapshot) throws Exception {
        JSONObject payload = payload(snapshot);
        return new JSONObject(payload.toString()).put("integrity_sha256", digest(payload.toString()));
    }

    static Snapshot parse(String encoded) throws Exception {
        if (safe(encoded).isEmpty()) return null;
        JSONObject envelope = new JSONObject(encoded);
        String integrity = normalizedSha(envelope.optString("integrity_sha256"));
        envelope.remove("integrity_sha256");
        if (!integrity.matches("[a-f0-9]{64}") || !integrity.equals(digest(envelope.toString()))) {
            throw new IllegalArgumentException("release rescue cache integrity mismatch");
        }
        int schemaVersion = envelope.optInt("schema_version", 0);
        if (schemaVersion != 1 && schemaVersion != 2) {
            throw new IllegalArgumentException("release rescue cache schema is unsupported");
        }
        JSONArray signers = envelope.optJSONArray("continuity_signers");
        ArrayList<String> signerDigests = new ArrayList<>();
        if (signers == null || signers.length() == 0 || signers.length() > 8) {
            throw new IllegalArgumentException("release rescue signer set is invalid");
        }
        for (int i = 0; i < signers.length(); i++) {
            String signer = normalizedSha(signers.optString(i));
            if (!signer.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("release rescue signer is invalid");
            }
            signerDigests.add(signer);
        }
        String installedSha = normalizedSha(envelope.optString("installed_sha256"));
        long installedCode = envelope.optLong("installed_version_code", 0L);
        if (!installedSha.matches("[a-f0-9]{64}") || installedCode <= 0L) {
            throw new IllegalArgumentException("release rescue installed identity is invalid");
        }
        String origin = required(envelope, "origin");
        MoaForwardRecoveryManifest forward = schemaVersion >= 2
                ? MoaForwardRecoveryManifest.fromCacheJson(
                        envelope.optJSONObject("forward_recovery")) : null;
        if (forward != null && !origin.equals(forward.origin)) {
            throw new IllegalArgumentException("release rescue recovery origin mismatch");
        }
        return new Snapshot(origin, required(envelope, "device_id"),
                required(envelope, "installed_version"), installedCode, installedSha,
                signerDigests, Entry.parse(envelope.optJSONObject("stable"), "stable"),
                Entry.parse(envelope.optJSONObject("trial"), "preview"),
                envelope.optLong("captured_at", 0L), forward);
    }

    private static JSONObject payload(Snapshot value) throws Exception {
        JSONObject payload = new JSONObject()
                .put("schema_version", 2)
                .put("origin", value.origin)
                .put("device_id", value.deviceId)
                .put("installed_version", value.installedVersion)
                .put("installed_version_code", value.installedVersionCode)
                .put("installed_sha256", value.installedSha256)
                .put("continuity_signers", new JSONArray(value.signerDigests))
                .put("captured_at", value.capturedAt);
        if (value.stable != null) payload.put("stable", value.stable.toJson());
        if (value.trial != null) payload.put("trial", value.trial.toJson());
        if (value.forwardRecovery != null) {
            payload.put("forward_recovery", value.forwardRecovery.toCacheJson());
        }
        return payload;
    }

    private static String digest(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(64);
        for (byte item : bytes) result.append(String.format("%02x", item & 0xff));
        return result.toString();
    }

    private static String required(JSONObject value, String key) {
        String result = safe(value.optString(key));
        if (result.isEmpty() || result.length() > 512) {
            throw new IllegalArgumentException("release rescue " + key + " is invalid");
        }
        return result;
    }

    private static String normalizedSha(String value) {
        return safe(value).toLowerCase();
    }

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    static final class Snapshot {
        final String origin;
        final String deviceId;
        final String installedVersion;
        final long installedVersionCode;
        final String installedSha256;
        final List<String> signerDigests;
        final Entry stable;
        final Entry trial;
        final long capturedAt;
        final MoaForwardRecoveryManifest forwardRecovery;

        Snapshot(String origin, String deviceId, String installedVersion,
                long installedVersionCode, String installedSha256, List<String> signerDigests,
                Entry stable, Entry trial, long capturedAt) {
            this(origin, deviceId, installedVersion, installedVersionCode, installedSha256,
                    signerDigests, stable, trial, capturedAt, null);
        }

        Snapshot(String origin, String deviceId, String installedVersion,
                long installedVersionCode, String installedSha256, List<String> signerDigests,
                Entry stable, Entry trial, long capturedAt,
                MoaForwardRecoveryManifest forwardRecovery) {
            this.origin = origin;
            this.deviceId = deviceId;
            this.installedVersion = installedVersion;
            this.installedVersionCode = installedVersionCode;
            this.installedSha256 = installedSha256;
            this.signerDigests = Collections.unmodifiableList(new ArrayList<>(signerDigests));
            this.stable = stable;
            this.trial = trial;
            this.capturedAt = capturedAt;
            this.forwardRecovery = forwardRecovery;
        }

        Snapshot withForwardRecovery(MoaForwardRecoveryManifest recovery) {
            return new Snapshot(origin, deviceId, installedVersion, installedVersionCode,
                    installedSha256, signerDigests, stable, trial, capturedAt, recovery);
        }
    }

    static final class Entry {
        final String channel;
        final String releaseId;
        final String bundleId;
        final String versionName;
        final long versionCode;
        final String sha256;
        final long sizeBytes;
        final String downloadUrl;

        Entry(String channel, String releaseId, String bundleId, String versionName,
                long versionCode, String sha256, long sizeBytes, String downloadUrl) {
            this.channel = channel;
            this.releaseId = releaseId;
            this.bundleId = bundleId;
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.sha256 = sha256;
            this.sizeBytes = sizeBytes;
            this.downloadUrl = downloadUrl;
        }

        static Entry fromCandidate(MoaReleaseSelectionPolicy.Candidate candidate) {
            if (candidate == null || !candidate.installable()) return null;
            return new Entry(candidate.channel, candidate.releaseId, candidate.bundleId,
                    candidate.artifact.versionName, candidate.artifact.versionCode,
                    candidate.artifact.sha256, candidate.artifact.sizeBytes,
                    candidate.artifact.downloadUrl);
        }

        static Entry parse(JSONObject value, String channel) {
            if (value == null) return null;
            String actualChannel = safe(value.optString("channel"));
            String sha = normalizedSha(value.optString("sha256"));
            long code = value.optLong("version_code", 0L);
            long size = value.optLong("size_bytes", 0L);
            String appId = safe(value.optString("app_id"));
            String url = required(value, "download_url");
            if (!channel.equals(actualChannel) || !"ag.companion".equals(appId)
                    || code <= 0L || size <= 0L || !sha.matches("[a-f0-9]{64}")
                    || !(url.startsWith("https://") || url.startsWith("http://"))) {
                throw new IllegalArgumentException("release rescue entry is invalid");
            }
            return new Entry(actualChannel, required(value, "release_id"),
                    required(value, "bundle_id"), required(value, "version_name"),
                    code, sha, size, url);
        }

        JSONObject toJson() throws Exception {
            return new JSONObject().put("channel", channel).put("app_id", "ag.companion")
                    .put("release_id", releaseId).put("bundle_id", bundleId)
                    .put("version_name", versionName).put("version_code", versionCode)
                    .put("sha256", sha256).put("size_bytes", sizeBytes)
                    .put("download_url", downloadUrl);
        }

        MoaReleaseSelectionPolicy.Candidate candidate() {
            return new MoaReleaseSelectionPolicy.Candidate(releaseId, bundleId, channel, "",
                    true, "", new MoaReleaseSelectionPolicy.Artifact(
                    "ag.companion", versionCode, versionName, sha256, sizeBytes, downloadUrl));
        }
    }
}

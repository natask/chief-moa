package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.Locale;

/** Fail-closed parser for one exact, forward-versioned Android recovery artifact. */
final class MoaForwardRecoveryManifest {
    private static final String SCHEMA = "moa-forward-recovery-manifest/v1";
    private static final String ID = "[A-Za-z0-9._:-]{1,160}";
    private static final String SHA256 = "[a-f0-9]{64}";
    private static final String COMMIT = "(?:[a-f0-9]{40}|[a-f0-9]{64})";

    final String recoveryId;
    final String origin;
    final String targetReleaseId;
    final String targetBundleId;
    final String targetSourceCommit;
    final String targetArtifactSha256;
    final String predecessorReleaseId;
    final long predecessorVersionCode;
    final String predecessorArtifactSha256;
    final String artifactReleaseId;
    final long artifactVersionCode;
    final String artifactVersionName;
    final String artifactSha256;
    final long artifactSizeBytes;
    final String artifactSignerSha256;
    final String downloadUrl;

    private MoaForwardRecoveryManifest(
            String recoveryId, String origin, Identity target, Identity predecessor,
            String artifactReleaseId, long artifactVersionCode, String artifactVersionName,
            String artifactSha256, long artifactSizeBytes, String artifactSignerSha256,
            String downloadUrl) {
        this.recoveryId = recoveryId;
        this.origin = origin;
        this.targetReleaseId = target.releaseId;
        this.targetBundleId = target.bundleId;
        this.targetSourceCommit = target.sourceCommit;
        this.targetArtifactSha256 = target.artifactSha256;
        this.predecessorReleaseId = predecessor.releaseId;
        this.predecessorVersionCode = predecessor.versionCode;
        this.predecessorArtifactSha256 = predecessor.artifactSha256;
        this.artifactReleaseId = artifactReleaseId;
        this.artifactVersionCode = artifactVersionCode;
        this.artifactVersionName = artifactVersionName;
        this.artifactSha256 = artifactSha256;
        this.artifactSizeBytes = artifactSizeBytes;
        this.artifactSignerSha256 = artifactSignerSha256;
        this.downloadUrl = downloadUrl;
    }

    static MoaForwardRecoveryManifest recommended(
            JSONObject envelope, String expectedOrigin, String expectedDeviceId,
            long installedVersionCode, String installedSha256) {
        if (envelope == null) throw invalid("manifest is missing");
        if (!"chief-moa".equals(envelope.optString("application_id", ""))
                || !requiredId(expectedDeviceId, "device_id").equals(
                        requiredId(envelope.optString("device_id", ""), "manifest.device_id"))) {
            throw invalid("manifest scope is invalid");
        }
        String recommended = optionalId(envelope.optString("recommended_recovery_id", ""));
        if (recommended.isEmpty()) return null;
        JSONArray recoveries = envelope.optJSONArray("recoveries");
        if (recoveries == null || recoveries.length() > 8) throw invalid("recovery list is invalid");
        JSONObject selected = null;
        for (int index = 0; index < recoveries.length(); index++) {
            JSONObject item = recoveries.optJSONObject(index);
            if (item == null) throw invalid("recovery entry is invalid");
            if (recommended.equals(item.optString("recovery_id", ""))) {
                if (selected != null) throw invalid("recommended recovery is duplicated");
                selected = item;
            }
        }
        if (selected == null) throw invalid("recommended recovery is unavailable");
        return parse(selected, envelope, expectedOrigin, expectedDeviceId,
                installedVersionCode, installedSha256);
    }

    private static MoaForwardRecoveryManifest parse(
            JSONObject value, JSONObject envelope, String expectedOrigin, String expectedDeviceId,
            long installedVersionCode, String installedSha256) {
        if (!SCHEMA.equals(value.optString("schema_version", ""))
                || !"chief-moa".equals(value.optString("application_id", ""))
                || !requiredId(expectedDeviceId, "device_id").equals(
                        requiredId(value.optString("device_id", ""), "device_id"))) {
            throw invalid("recovery scope is invalid");
        }
        String recoveryId = requiredId(value.optString("recovery_id", ""), "recovery_id");
        Identity target = identity(value.optJSONObject("target"), true, "target");
        if (!"stable".equals(target.channel) || target.versionCode <= 0L) {
            throw invalid("recovery target is not stable");
        }
        Identity stable = currentStable(envelope);
        if (!target.sameRelease(stable)) throw invalid("recovery target is stale");

        Identity predecessor = identity(value.optJSONObject("predecessor"), false, "predecessor");
        String runningSha = sha(installedSha256, "installed_sha256");
        if (installedVersionCode <= 0L
                || predecessor.versionCode != installedVersionCode
                || !predecessor.artifactSha256.equals(runningSha)) {
            throw invalid("recovery predecessor does not match the installed app");
        }

        JSONObject artifact = object(value, "artifact");
        String artifactRelease = requiredId(artifact.optString("release_id", ""),
                "artifact.release_id");
        if (!artifactRelease.equals(recoveryId)) {
            throw invalid("artifact release does not match recovery id");
        }
        long artifactVersion = positive(artifact.optLong("version_code", 0L),
                "artifact.version_code");
        if (artifactVersion <= installedVersionCode || artifactVersion <= predecessor.versionCode) {
            throw invalid("recovery artifact is not forward-versioned");
        }
        if (!"ag.companion".equals(artifact.optString("package_name", ""))) {
            throw invalid("recovery package is invalid");
        }
        String artifactSource = commit(artifact.optString("source_commit", ""),
                "artifact.source_commit");
        String artifactSha = sha(artifact.optString("sha256", ""), "artifact.sha256");
        long artifactSize = positive(artifact.optLong("size_bytes", 0L), "artifact.size_bytes");
        String signer = sha(artifact.optString("signer_sha256", ""), "artifact.signer_sha256");
        String download = sameOriginRecoveryUrl(expectedOrigin,
                requiredText(artifact.optString("download_url", ""), "artifact.download_url"));

        JSONObject provenance = object(value, "provenance");
        commit(provenance.optString("builder_commit", ""), "provenance.builder_commit");
        if (!artifactSource.equals(target.sourceCommit)
                || !target.bundleId.equals(requiredId(
                        provenance.optString("target_bundle_id", ""), "provenance.target_bundle_id"))
                || !target.releaseId.equals(requiredId(
                        provenance.optString("target_release_id", ""), "provenance.target_release_id"))
                || !target.sourceCommit.equals(commit(
                        provenance.optString("target_source_commit", ""),
                        "provenance.target_source_commit"))
                || !predecessor.releaseId.equals(requiredId(
                        provenance.optString("predecessor_release_id", ""),
                        "provenance.predecessor_release_id"))) {
            throw invalid("recovery provenance does not bind its source identities");
        }
        validateParents(value.optJSONObject("parents"), provenance, target, predecessor);
        sha(provenance.optString("provenance_sha256", ""),
                "provenance.provenance_sha256");
        return new MoaForwardRecoveryManifest(recoveryId, normalizedOrigin(expectedOrigin),
                target, predecessor, artifactRelease,
                artifactVersion, requiredText(artifact.optString("version_name", ""),
                "artifact.version_name"), artifactSha, artifactSize, signer, download);
    }

    boolean matchesInstalled(long versionCode, String sha256, java.util.Set<String> signers) {
        return predecessorVersionCode == versionCode
                && predecessorArtifactSha256.equals(safe(sha256).toLowerCase(Locale.US))
                && artifactVersionCode > versionCode
                && MoaReleaseArtifactVerifier.declaresInstalledSigner(signers, artifactSignerSha256);
    }

    JSONObject toCacheJson() throws Exception {
        return new JSONObject().put("recovery_id", recoveryId).put("origin", origin)
                .put("target_release_id", targetReleaseId).put("target_bundle_id", targetBundleId)
                .put("target_source_commit", targetSourceCommit)
                .put("target_artifact_sha256", targetArtifactSha256)
                .put("predecessor_release_id", predecessorReleaseId)
                .put("predecessor_version_code", predecessorVersionCode)
                .put("predecessor_artifact_sha256", predecessorArtifactSha256)
                .put("artifact_release_id", artifactReleaseId)
                .put("artifact_version_code", artifactVersionCode)
                .put("artifact_version_name", artifactVersionName)
                .put("artifact_sha256", artifactSha256)
                .put("artifact_size_bytes", artifactSizeBytes)
                .put("artifact_signer_sha256", artifactSignerSha256)
                .put("download_url", downloadUrl);
    }

    static MoaForwardRecoveryManifest fromCacheJson(JSONObject value) {
        if (value == null) return null;
        String origin = normalizedOrigin(requiredText(value.optString("origin", ""), "origin"));
        Identity target = new Identity("stable",
                requiredId(value.optString("target_bundle_id", ""), "target_bundle_id"),
                requiredId(value.optString("target_release_id", ""), "target_release_id"),
                commit(value.optString("target_source_commit", ""), "target_source_commit"),
                sha(value.optString("target_artifact_sha256", ""), "target_artifact_sha256"),
                1L, -1L);
        Identity predecessor = new Identity("",
                "cached-predecessor",
                requiredId(value.optString("predecessor_release_id", ""),
                        "predecessor_release_id"),
                "0".repeat(40),
                sha(value.optString("predecessor_artifact_sha256", ""),
                        "predecessor_artifact_sha256"),
                positive(value.optLong("predecessor_version_code", 0L),
                        "predecessor_version_code"), -1L);
        String download = sameOriginRecoveryUrl(origin,
                requiredText(value.optString("download_url", ""), "download_url"));
        long artifactVersion = positive(value.optLong("artifact_version_code", 0L),
                "artifact_version_code");
        if (artifactVersion <= predecessor.versionCode) {
            throw invalid("cached artifact is not forward-versioned");
        }
        return new MoaForwardRecoveryManifest(
                requiredId(value.optString("recovery_id", ""), "recovery_id"), origin,
                target, predecessor,
                requiredId(value.optString("artifact_release_id", ""), "artifact_release_id"),
                artifactVersion,
                requiredText(value.optString("artifact_version_name", ""), "artifact_version_name"),
                sha(value.optString("artifact_sha256", ""), "artifact_sha256"),
                positive(value.optLong("artifact_size_bytes", 0L), "artifact_size_bytes"),
                sha(value.optString("artifact_signer_sha256", ""), "artifact_signer_sha256"),
                download);
    }

    private static Identity currentStable(JSONObject envelope) {
        JSONObject channels = object(envelope, "channels");
        JSONObject stable = object(channels, "stable");
        long sequence = stable.optLong("sequence", -1L);
        if (sequence < 0L) throw invalid("stable sequence is invalid");
        JSONObject bundle = object(stable, "bundle");
        String bundleId = requiredId(bundle.optString("bundle_id", ""), "stable.bundle_id");
        String releaseId = requiredId(bundle.optString("release_id", ""), "stable.release_id");
        JSONArray candidates = envelope.optJSONArray("candidates");
        if (candidates == null) throw invalid("stable candidate is unavailable");
        for (int index = 0; index < candidates.length(); index++) {
            JSONObject candidate = candidates.optJSONObject(index);
            if (candidate != null && "stable".equals(candidate.optString("channel", ""))
                    && bundleId.equals(candidate.optString("bundle_id", ""))
                    && releaseId.equals(candidate.optString("release_id", ""))) {
                JSONObject artifact = object(candidate, "artifact");
                return new Identity("stable", bundleId, releaseId,
                        commit(candidate.optString("source_ref", ""), "stable.source_ref"),
                        sha(artifact.optString("sha256", ""), "stable.artifact_sha256"),
                        artifact.optLong("version_code", 0L), sequence);
            }
        }
        throw invalid("stable candidate is unavailable");
    }

    private static Identity identity(JSONObject value, boolean channelRequired, String path) {
        if (value == null) throw invalid(path + " is missing");
        String channel = channelRequired
                ? requiredId(value.optString("channel", ""), path + ".channel") : "";
        long sequence = channelRequired ? value.optLong("sequence", -1L) : -1L;
        if (channelRequired && sequence < 0L) throw invalid(path + ".sequence is invalid");
        return new Identity(channel,
                requiredId(value.optString("bundle_id", ""), path + ".bundle_id"),
                requiredId(value.optString("release_id", ""), path + ".release_id"),
                commit(value.optString("source_commit", ""), path + ".source_commit"),
                sha(value.optString("artifact_sha256", ""), path + ".artifact_sha256"),
                value.optLong("version_code", 0L), sequence);
    }

    private static void validateParents(JSONObject parents, JSONObject provenance,
            Identity target, Identity predecessor) {
        if (parents == null) throw invalid("recovery parents are missing");
        JSONObject stable = object(parents, "stable");
        String stableBundle = requiredId(stable.optString("bundle_id", ""),
                "parents.stable.bundle_id");
        String stableRelease = requiredId(stable.optString("release_id", ""),
                "parents.stable.release_id");
        long stableSequence = stable.optLong("sequence", -1L);
        if (!stableBundle.equals(target.bundleId) || !stableRelease.equals(target.releaseId)
                || stableSequence != target.sequence) {
            throw invalid("stable parent does not match target");
        }
        if (!stableBundle.equals(requiredId(
                provenance.optString("parent_stable_bundle_id", ""),
                "provenance.parent_stable_bundle_id"))) {
            throw invalid("stable parent provenance is invalid");
        }
        JSONObject trial = parents.optJSONObject("trial");
        String trialBundle = trial == null ? "" : requiredId(
                trial.optString("bundle_id", ""), "parents.trial.bundle_id");
        String trialRelease = trial == null ? "" : requiredId(
                trial.optString("release_id", ""), "parents.trial.release_id");
        if (trial != null && trial.optLong("sequence", -1L) < 0L) {
            throw invalid("trial parent sequence is invalid");
        }
        if (!trialBundle.equals(optionalId(
                provenance.optString("parent_trial_bundle_id", "")))) {
            throw invalid("trial parent provenance is invalid");
        }
        boolean predecessorIsStable = stableBundle.equals(predecessor.bundleId)
                && stableRelease.equals(predecessor.releaseId);
        boolean predecessorIsTrial = !trialBundle.isEmpty()
                && trialBundle.equals(predecessor.bundleId)
                && trialRelease.equals(predecessor.releaseId);
        if (!predecessorIsStable && !predecessorIsTrial) {
            throw invalid("predecessor is not a confirmed parent");
        }
    }

    private static String sameOriginRecoveryUrl(String expectedOrigin, String value) {
        try {
            URI origin = URI.create(expectedOrigin);
            URI target = URI.create(value);
            if (!origin.getScheme().equalsIgnoreCase(target.getScheme())
                    || !origin.getAuthority().equalsIgnoreCase(target.getAuthority())
                    || target.getRawQuery() != null || target.getRawFragment() != null
                    || !target.getPath().startsWith("/v1/release-recovery/artifacts/")
                    || !target.getPath().endsWith(".apk")) {
                throw invalid("recovery download URL is outside the gateway origin");
            }
            return target.toString();
        } catch (IllegalArgumentException error) {
            if (error.getMessage() != null && error.getMessage().startsWith("forward recovery")) {
                throw error;
            }
            throw invalid("recovery download URL is invalid");
        }
    }

    private static String normalizedOrigin(String value) {
        try {
            URI origin = URI.create(value);
            if (!("https".equalsIgnoreCase(origin.getScheme())
                    || "http".equalsIgnoreCase(origin.getScheme()))
                    || origin.getAuthority() == null || origin.getRawQuery() != null
                    || origin.getRawFragment() != null) throw invalid("origin is invalid");
            String result = origin.toString();
            while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
            return result;
        } catch (IllegalArgumentException error) {
            if (error.getMessage() != null && error.getMessage().startsWith("forward recovery")) {
                throw error;
            }
            throw invalid("origin is invalid");
        }
    }

    private static JSONObject object(JSONObject value, String key) {
        JSONObject result = value == null ? null : value.optJSONObject(key);
        if (result == null) throw invalid(key + " is missing");
        return result;
    }

    private static long positive(long value, String path) {
        if (value <= 0L) throw invalid(path + " is invalid");
        return value;
    }

    private static String sha(String value, String path) {
        String result = safe(value).toLowerCase(Locale.US);
        if (!result.matches(SHA256)) throw invalid(path + " is invalid");
        return result;
    }

    private static String commit(String value, String path) {
        String result = safe(value).toLowerCase(Locale.US);
        if (!result.matches(COMMIT)) throw invalid(path + " is invalid");
        return result;
    }

    private static String requiredId(String value, String path) {
        String result = safe(value);
        if (!result.matches(ID)) throw invalid(path + " is invalid");
        return result;
    }

    private static String optionalId(String value) {
        String result = safe(value);
        if (!result.isEmpty() && !result.matches(ID)) throw invalid("optional id is invalid");
        return result;
    }

    private static String requiredText(String value, String path) {
        String result = safe(value);
        if (result.isEmpty() || result.length() > 2048) throw invalid(path + " is invalid");
        return result;
    }

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static IllegalArgumentException invalid(String message) {
        return new IllegalArgumentException("forward recovery " + message);
    }

    private static final class Identity {
        final String channel;
        final String bundleId;
        final String releaseId;
        final String sourceCommit;
        final String artifactSha256;
        final long versionCode;
        final long sequence;

        Identity(String channel, String bundleId, String releaseId, String sourceCommit,
                String artifactSha256, long versionCode, long sequence) {
            this.channel = channel;
            this.bundleId = bundleId;
            this.releaseId = releaseId;
            this.sourceCommit = sourceCommit;
            this.artifactSha256 = artifactSha256;
            this.versionCode = versionCode;
            this.sequence = sequence;
        }

        boolean sameRelease(Identity other) {
            return other != null && bundleId.equals(other.bundleId)
                    && releaseId.equals(other.releaseId)
                    && sourceCommit.equals(other.sourceCommit)
                    && artifactSha256.equals(other.artifactSha256)
                    && versionCode == other.versionCode && sequence == other.sequence;
        }
    }
}

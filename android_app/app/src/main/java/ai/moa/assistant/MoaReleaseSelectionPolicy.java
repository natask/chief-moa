package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Comparator;

/** Pure, fail-closed parser for the Android release-control projection. */
final class MoaReleaseSelectionPolicy {
    private static final String ID = "[A-Za-z0-9._:-]{1,160}";
    private static final String SHA256 = "[a-f0-9]{64}";
    private static final int MAX_CANDIDATES = 32;
    private static final int MAX_FEEDBACK_CHARS = 16_000;

    static final class Artifact {
        final String appId;
        final long versionCode;
        final String versionName;
        final String sha256;
        final long sizeBytes;
        final String downloadUrl;

        Artifact(String appId, long versionCode, String versionName, String sha256,
                 long sizeBytes, String downloadUrl) {
            this.appId = appId;
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.sha256 = sha256;
            this.sizeBytes = sizeBytes;
            this.downloadUrl = downloadUrl;
        }

        JSONObject asUpdateManifest() throws Exception {
            return new JSONObject()
                    .put("app_id", appId)
                    .put("version_code", versionCode)
                    .put("version_name", versionName)
                    .put("sha256", sha256)
                    .put("size_bytes", sizeBytes)
                    .put("download_url", downloadUrl);
        }
    }

    static final class Candidate {
        final String releaseId;
        final String bundleId;
        final String channel;
        final String sourceRef;
        final boolean compatible;
        final String compatibilityReason;
        final Artifact artifact;
        final String createdAt;
        final String lineageKind;
        final String seriesParentBundleId;
        final List<String> parallelParentBundleIds;

        Candidate(String releaseId, String bundleId, String channel, String sourceRef,
                  boolean compatible, String compatibilityReason, Artifact artifact) {
            this(releaseId, bundleId, channel, sourceRef, compatible, compatibilityReason,
                    artifact, "", "root", "", Collections.emptyList());
        }

        Candidate(String releaseId, String bundleId, String channel, String sourceRef,
                  boolean compatible, String compatibilityReason, Artifact artifact,
                  String createdAt, String lineageKind, String seriesParentBundleId,
                  List<String> parallelParentBundleIds) {
            this.releaseId = releaseId;
            this.bundleId = bundleId;
            this.channel = channel;
            this.sourceRef = sourceRef;
            this.compatible = compatible;
            this.compatibilityReason = compatibilityReason;
            this.artifact = artifact;
            this.createdAt = createdAt;
            this.lineageKind = lineageKind;
            this.seriesParentBundleId = seriesParentBundleId;
            this.parallelParentBundleIds = Collections.unmodifiableList(
                    new ArrayList<>(parallelParentBundleIds));
        }

        boolean installable() {
            return compatible && artifact != null;
        }

        String label() {
            String version = artifact == null ? "" : artifact.versionName;
            String base = channel + (version.isEmpty() ? "" : " · v" + version);
            return sourceRef.isEmpty() ? base : base + " · " + sourceRef;
        }


        String humanLabel() {
            String version = artifact == null ? "" : artifact.versionName;
            return version.isEmpty() ? bundleId : "A.G. " + version;
        }

        String summary() {
            if ("composed".equals(lineageKind)) {
                return "Combines " + parallelParentBundleIds.size() + " parallel feature slices.";
            }
            if (!seriesParentBundleId.isEmpty()) {
                return "Continues after " + seriesParentBundleId + ".";
            }
            return "Independent release candidate.";
        }

        String relationLabel() {
            if ("composed".equals(lineageKind)) return "parallel bundle";
            if (!seriesParentBundleId.isEmpty()) return "series";
            return "root";
        }
    }

    static final class CatalogPage {
        final List<Candidate> candidates;
        final String nextCursor;

        CatalogPage(List<Candidate> candidates, String nextCursor) {
            this.candidates = Collections.unmodifiableList(new ArrayList<>(candidates));
            this.nextCursor = nextCursor;
        }
    }

    static final class Assignment {
        final String assignmentId;
        final long sequence;
        final String source;
        final String channel;
        final String bundleId;
        final String releaseId;
        final String artifactSha256;

        Assignment(String assignmentId, long sequence, String source, String channel,
                   String bundleId, String releaseId, String artifactSha256) {
            this.assignmentId = assignmentId;
            this.sequence = sequence;
            this.source = source;
            this.channel = channel;
            this.bundleId = bundleId;
            this.releaseId = releaseId;
            this.artifactSha256 = artifactSha256;
        }
    }

    static final class View {
        final String reportedInstalledReleaseId;
        final String reportedInstalledSha256;
        final Assignment assignment;
        final Candidate stable;
        final Candidate preview;
        final boolean hasLastKnownGood;
        final List<Candidate> candidates;

        View(String reportedInstalledReleaseId, String reportedInstalledSha256,
             Assignment assignment, Candidate stable, Candidate preview,
             boolean hasLastKnownGood, List<Candidate> candidates) {
            this.reportedInstalledReleaseId = reportedInstalledReleaseId;
            this.reportedInstalledSha256 = reportedInstalledSha256;
            this.assignment = assignment;
            this.stable = stable;
            this.preview = preview;
            this.hasLastKnownGood = hasLastKnownGood;
            this.candidates = Collections.unmodifiableList(candidates);
        }
    }

    private MoaReleaseSelectionPolicy() {
    }

    static View parseView(JSONObject payload) {
        if (payload == null) throw new IllegalArgumentException("release view is missing");
        JSONObject root = payload.optJSONObject("view");
        if (root == null) root = payload;
        if (root.optInt("schema_version", 0) != 1
                || !"chief-moa".equals(root.optString("application_id", ""))) {
            throw new IllegalArgumentException("release view schema or application is invalid");
        }
        JSONObject installed = root.optJSONObject("installed");
        String installedReleaseId = "";
        String installedSha = "";
        if (installed != null) {
            if (!"android".equals(installed.optString("surface", ""))) {
                throw new IllegalArgumentException("installed Android surface is invalid");
            }
            installedReleaseId = requireId(
                    installed.optString("release_id", ""), "installed.release_id");
            installedSha = safe(installed.optString("artifact_sha256", ""))
                    .toLowerCase(Locale.US);
            if (!installedSha.matches(SHA256)
                    || installed.optLong("version_code", 0L) <= 0L
                    || bounded(installed.optString("version_name", ""), 64).isEmpty()
                    || bounded(installed.optString("status", ""), 40).isEmpty()) {
                throw new IllegalArgumentException("installed Android projection is invalid");
            }
        }

        Assignment assignment = parseAssignment(firstObject(
                root, "effective_assignment", "assignment"));

        ArrayList<Candidate> candidates = new ArrayList<>();
        JSONArray items = root.optJSONArray("candidates");
        if (items != null) {
            if (items.length() > MAX_CANDIDATES) {
                throw new IllegalArgumentException("release candidate list is too large");
            }
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) throw new IllegalArgumentException("release candidate is invalid");
                candidates.add(parseCandidate(item, ""));
            }
        }
        JSONObject channels = root.optJSONObject("channels");
        if (channels == null) throw new IllegalArgumentException("release channels are missing");
        Candidate stable = channelCandidate(channels.optJSONObject("stable"), "stable", candidates);
        Candidate preview = channelCandidate(channels.optJSONObject("preview"), "preview", candidates);
        JSONObject lastKnownGood = root.optJSONObject("last_known_good");
        boolean hasLastKnownGood = false;
        if (lastKnownGood != null) {
            requireId(lastKnownGood.optString("assignment_id", ""), "last_known_good.assignment_id");
            requireId(lastKnownGood.optString("bundle_id", ""), "last_known_good.bundle_id");
            requireId(lastKnownGood.optString("release_id", ""), "last_known_good.release_id");
            hasLastKnownGood = true;
        }
        if (assignment == null && stable == null && preview == null && candidates.isEmpty()) {
            throw new IllegalArgumentException("release view has no assignment or candidates");
        }
        return new View(installedReleaseId, installedSha, assignment, stable, preview,
                hasLastKnownGood, candidates);
    }

    static Candidate selectedCandidate(JSONObject response, String expectedChannel) {
        if (response == null) throw new IllegalArgumentException("assignment response is missing");
        if (response.optBoolean("install_confirmed", true)) {
            throw new IllegalArgumentException("assignment response falsely claims installation");
        }
        Assignment assignment = parseAssignment(response.optJSONObject("effective_assignment"));
        JSONObject action = response.optJSONObject("platform_action");
        if (assignment == null || action == null) {
            throw new IllegalArgumentException("assignment response is incomplete");
        }
        String kind = action.optString("kind", "");
        if (!"android_install_review".equals(kind) && !"none".equals(kind)) {
            throw new IllegalArgumentException("assignment platform action is unsupported");
        }
        Artifact artifact = "android_install_review".equals(kind)
                ? parseArtifact(action.optJSONObject("artifact")) : null;
        Candidate candidate = new Candidate(
                assignment.releaseId,
                requireId(assignmentBundleId(response.optJSONObject("effective_assignment")), "bundle_id"),
                assignment.channel,
                "",
                true,
                "",
                artifact);
        if (candidate == null || !expectedChannel.equals(candidate.channel)) {
            throw new IllegalArgumentException("assignment response does not bind the requested channel");
        }
        return candidate;
    }

    static Assignment assignmentFromResponse(JSONObject response) {
        if (response == null || response.optBoolean("install_confirmed", true)) {
            throw new IllegalArgumentException("assignment response is invalid");
        }
        if (response.optJSONObject("assignment_receipt") == null) {
            throw new IllegalArgumentException("assignment receipt is missing");
        }
        return parseAssignment(response.optJSONObject("effective_assignment"));
    }

    static JSONObject assignmentRequest(String deviceId, String channel, Candidate candidate,
                                        long expectedSequence, String idempotencyKey) throws Exception {
        requireId(deviceId, "device_id");
        requireChannel(channel);
        if (candidate == null || !channel.equals(candidate.channel) || !candidate.compatible) {
            throw new IllegalArgumentException("a compatible channel candidate is required");
        }
        JSONObject body = new JSONObject()
                .put("device_id", deviceId)
                .put("surface", "android")
                .put("channel", channel)
                .put("release_id", candidate.releaseId)
                .put("bundle_id", candidate.bundleId)
                .put("expected_assignment_sequence", requireSequence(expectedSequence))
                .put("idempotency_key", requireId(idempotencyKey, "idempotency_key"));
        return body;
    }

    static CatalogPage parseCatalog(JSONObject payload) {
        if (payload == null || payload.optInt("schema_version", 0) != 1) {
            throw new IllegalArgumentException("candidate catalog schema is invalid");
        }
        JSONArray items = payload.optJSONArray("candidates");
        if (items == null || items.length() > 100) {
            throw new IllegalArgumentException("candidate catalog page is invalid");
        }
        ArrayList<Candidate> parsed = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) throw new IllegalArgumentException("release candidate is invalid");
            String bundleId = requireId(item.optString("bundle_id", ""), "candidate.bundle_id");
            int compatibilityVersion = item.optInt("compatibility_version", 0);
            JSONObject lineage = item.optJSONObject("lineage");
            if (lineage == null) throw new IllegalArgumentException("candidate lineage is missing");
            String kind = requireLineageKind(lineage.optString("kind", ""));
            String seriesParent = optionalId(lineage.optString("series_parent_bundle_id", ""));
            JSONArray parents = lineage.optJSONArray("parallel_parent_bundle_ids");
            if (parents == null || parents.length() > 32) {
                throw new IllegalArgumentException("candidate parallel lineage is invalid");
            }
            ArrayList<String> parallelParents = new ArrayList<>();
            for (int p = 0; p < parents.length(); p++) {
                parallelParents.add(requireId(parents.optString(p, ""), "parallel_parent_bundle_id"));
            }
            Artifact artifact = parseArtifact(item.optJSONObject("artifact"));
            String releaseId = artifact == null ? optionalId(item.optString("release_id", ""))
                    : requireId(item.optString("release_id", ""), "candidate.release_id");
            boolean compatible = compatibilityVersion == 1 && artifact != null;
            parsed.add(new Candidate(releaseId, bundleId, "candidate", "", compatible,
                    compatible ? "" : artifact == null ? "Android artifact unavailable"
                            : "Requires compatibility version 1",
                    artifact, bounded(item.optString("created_at", ""), 80), kind,
                    seriesParent, parallelParents));
        }
        String cursor = optionalId(payload.optString("next_cursor", ""));
        return new CatalogPage(parsed, cursor);
    }

    static JSONObject exactCandidateRequest(String deviceId, Candidate candidate,
                                            long expectedSequence, String idempotencyKey) throws Exception {
        if (candidate == null || !"candidate".equals(candidate.channel) || !candidate.compatible
                || candidate.artifact == null) {
            throw new IllegalArgumentException("an exact compatible candidate is required");
        }
        return new JSONObject()
                .put("device_id", requireId(deviceId, "device_id"))
                .put("surface", "android")
                .put("bundle_id", candidate.bundleId)
                .put("release_id", candidate.releaseId)
                .put("expected_assignment_sequence", requireSequence(expectedSequence))
                .put("idempotency_key", requireId(idempotencyKey, "idempotency_key"));
    }

    static List<Candidate> rank(List<Candidate> input, String query, String selectedBundleId,
                                String runningDigest) {
        String needle = safe(query).toLowerCase(Locale.US);
        ArrayList<Candidate> result = new ArrayList<>();
        for (Candidate item : input == null ? Collections.<Candidate>emptyList() : input) {
            String haystack = (item.humanLabel() + " " + item.summary() + " " + item.bundleId
                    + " " + item.releaseId + " " + item.relationLabel()).toLowerCase(Locale.US);
            if (needle.isEmpty() || haystack.contains(needle)) result.add(item);
        }
        String selected = safe(selectedBundleId);
        String running = safe(runningDigest).toLowerCase(Locale.US);
        result.sort(Comparator
                .comparingInt((Candidate item) -> item.bundleId.equals(selected) ? 0
                        : item.artifact != null && item.artifact.sha256.equals(running) ? 1
                        : item.compatible ? 2 : 3)
                .thenComparing((Candidate item) -> item.createdAt, Comparator.reverseOrder())
                .thenComparing(item -> item.bundleId));
        return Collections.unmodifiableList(result);
    }

    static String coarseState(Candidate candidate, String selectedBundleId, String runningDigest) {
        if (candidate == null) return "unavailable";
        if (candidate.artifact != null && candidate.artifact.sha256.equals(
                safe(runningDigest).toLowerCase(Locale.US))) return "running";
        if (candidate.bundleId.equals(safe(selectedBundleId))) return "selected";
        return candidate.compatible ? "ready" : "blocked";
    }

    static String exactDeepLinkBundleId(String value) {
        String candidate = safe(value);
        return candidate.matches(ID) ? candidate : "";
    }

    static JSONObject fallbackRequest(String deviceId, long expectedSequence,
                                      String idempotencyKey) throws Exception {
        return new JSONObject()
                .put("device_id", requireId(deviceId, "device_id"))
                .put("surface", "android")
                .put("expected_assignment_sequence", requireSequence(expectedSequence))
                .put("idempotency_key", requireId(idempotencyKey, "idempotency_key"));
    }

    static JSONObject feedbackRequest(String deviceId, Assignment assignment, Candidate candidate,
                                      String text, String idempotencyKey) throws Exception {
        String comment = safe(text);
        if (comment.isEmpty() || comment.length() > MAX_FEEDBACK_CHARS) {
            throw new IllegalArgumentException("feedback must be 1-" + MAX_FEEDBACK_CHARS + " characters");
        }
        if (candidate == null || candidate.artifact == null) {
            throw new IllegalArgumentException("feedback requires an exact release artifact");
        }
        JSONObject body = new JSONObject()
                .put("device_id", requireId(deviceId, "device_id"))
                .put("release_id", candidate.releaseId)
                .put("bundle_id", candidate.bundleId)
                .put("surface", "android")
                .put("artifact_sha256", candidate.artifact.sha256)
                .put("channel", candidate.channel)
                .put("text", comment)
                .put("evidence_refs", new JSONArray())
                .put("idempotency_key", requireId(idempotencyKey, "idempotency_key"));
        if (assignment == null || assignment.assignmentId.isEmpty()
                || !assignment.releaseId.equals(candidate.releaseId)
                || !assignment.bundleId.equals(candidate.bundleId)
                || !assignment.channel.equals(candidate.channel)
                || (!assignment.artifactSha256.isEmpty()
                && !assignment.artifactSha256.equals(candidate.artifact.sha256))) {
            throw new IllegalArgumentException("feedback requires an exact assignment");
        }
        body.put("assignment_id", assignment.assignmentId);
        return body;
    }

    static JSONObject installReceipt(String deviceId, Assignment assignment, Candidate candidate, String state,
                                     String detail, String idempotencyKey) throws Exception {
        if (assignment == null || assignment.assignmentId.isEmpty()
                || candidate == null || candidate.artifact == null) {
            throw new IllegalArgumentException("install receipt requires an exact artifact");
        }
        String normalized = safe(state).toLowerCase(Locale.US);
        if (!List.of("download_verified", "installer_opened", "installed", "activated", "smoked", "refused", "failed")
                .contains(normalized)) {
            throw new IllegalArgumentException("install receipt state is unsupported");
        }
        return new JSONObject()
                .put("device_id", requireId(deviceId, "device_id"))
                .put("release_id", candidate.releaseId)
                .put("bundle_id", candidate.bundleId)
                .put("assignment_id", requireId(assignment.assignmentId, "assignment_id"))
                .put("surface", "android")
                .put("artifact_sha256", candidate.artifact.sha256)
                .put("status", normalized)
                .put("detail", bounded(detail, 500))
                .put("idempotency_key", requireId(idempotencyKey, "idempotency_key"));
    }

    static boolean exactRunningSelection(View view, Candidate candidate, String localArtifactSha256) {
        String localSha = safe(localArtifactSha256).toLowerCase(Locale.US);
        if (!localMatchesAssignment(view, candidate, localSha)) return false;
        return view.reportedInstalledReleaseId.equals(candidate.releaseId)
                && view.reportedInstalledSha256.equals(candidate.artifact.sha256);
    }

    static boolean localMatchesAssignment(
            View view, Candidate candidate, String localArtifactSha256) {
        String localSha = safe(localArtifactSha256).toLowerCase(Locale.US);
        if (view == null || view.assignment == null || candidate == null
                || !candidate.compatible || candidate.artifact == null
                || !localSha.matches(SHA256)) return false;
        return view.assignment.releaseId.equals(candidate.releaseId)
                && view.assignment.bundleId.equals(candidate.bundleId)
                && view.assignment.channel.equals(candidate.channel)
                && (view.assignment.artifactSha256.isEmpty()
                || view.assignment.artifactSha256.equals(candidate.artifact.sha256))
                && localSha.equals(candidate.artifact.sha256);
    }

    private static Assignment parseAssignment(JSONObject value) {
        if (value == null) return null;
        String releaseId = requireId(value.optString("release_id", ""), "assignment.release_id");
        String channel = requireChannel(value.optString("channel", ""));
        String assignmentId = optionalId(value.optString("assignment_id", value.optString("id", "")));
        String bundleId = requireId(value.optString("bundle_id", ""), "assignment.bundle_id");
        long sequence = value.optLong("sequence", -1L);
        if (assignmentId.isEmpty() || sequence < 0L) {
            throw new IllegalArgumentException("assignment identity is invalid");
        }
        String source = bounded(value.optString("source", value.optString("scope", "")), 80);
        String sha = safe(value.optString("artifact_sha256", "")).toLowerCase(Locale.US);
        if (!sha.isEmpty() && !sha.matches(SHA256)) {
            throw new IllegalArgumentException("assignment.artifact_sha256 is invalid");
        }
        return new Assignment(assignmentId, sequence, source, channel, bundleId, releaseId, sha);
    }

    private static Candidate parseCandidate(JSONObject value, String defaultChannel) {
        if (value == null) return null;
        String releaseId = requireId(value.optString("release_id", value.optString("id", "")),
                "candidate.release_id");
        String bundleId = optionalId(value.optString("bundle_id", releaseId));
        String channel = requireChannel(value.optString("channel", defaultChannel));
        String sourceRef = bounded(value.optString("source_ref", value.optString("git_sha", "")), 200);
        JSONObject compatibility = value.optJSONObject("compatibility");
        if (compatibility == null || !compatibility.has("eligible")
                || !(compatibility.opt("reasons") instanceof JSONArray)) {
            throw new IllegalArgumentException("candidate compatibility is invalid");
        }
        boolean compatible = compatibility.optBoolean("eligible", false);
        String reason = bounded(
                compatibility.optString("reason", joinReasons(compatibility.optJSONArray("reasons"))), 300);
        JSONObject artifactObject = value.optJSONObject("artifact");
        if (artifactObject == null) artifactObject = value.optJSONObject("android_artifact");
        Artifact artifact = parseArtifact(artifactObject);
        return new Candidate(releaseId, bundleId, channel, sourceRef, compatible, reason, artifact);
    }

    private static Artifact parseArtifact(JSONObject value) {
        if (value == null) return null;
        if (!"android".equals(value.optString("surface", ""))) {
            throw new IllegalArgumentException("candidate artifact surface is invalid");
        }
        String appId = safe(value.optString("app_id", ""));
        long versionCode = value.optLong("version_code", 0L);
        String versionName = bounded(value.optString("version_name", ""), 64);
        String sha = safe(value.optString("sha256", value.optString("artifact_sha256", "")))
                .toLowerCase(Locale.US);
        long size = value.optLong("size_bytes", 0L);
        String url = bounded(value.optString("download_url", ""), 1000);
        if (!"ai.moa.assistant".equals(appId) || versionCode <= 0L || versionName.isEmpty()
                || !sha.matches(SHA256) || size <= 0L || !isHttpUrl(url)) {
            throw new IllegalArgumentException("candidate Android artifact is invalid");
        }
        return new Artifact(appId, versionCode, versionName, sha, size, url);
    }

    private static Candidate findChannel(List<Candidate> candidates, String channel) {
        for (Candidate item : candidates) if (channel.equals(item.channel)) return item;
        return null;
    }

    private static Candidate channelCandidate(
            JSONObject head, String channel, List<Candidate> candidates) {
        if (head == null) return null;
        long sequence = head.optLong("sequence", -1L);
        JSONObject bundle = head.optJSONObject("bundle");
        if (sequence < 0L || bundle == null) {
            throw new IllegalArgumentException(channel + " channel head is invalid");
        }
        String bundleId = requireId(bundle.optString("bundle_id", bundle.optString("id", "")),
                channel + ".bundle_id");
        for (Candidate candidate : candidates) {
            if (channel.equals(candidate.channel) && bundleId.equals(candidate.bundleId)) return candidate;
        }
        throw new IllegalArgumentException(channel + " channel candidate is missing");
    }

    private static String assignmentBundleId(JSONObject assignment) {
        return assignment == null ? "" : assignment.optString("bundle_id", "");
    }

    private static JSONObject firstObject(JSONObject value, String... keys) {
        for (String key : keys) {
            JSONObject found = value.optJSONObject(key);
            if (found != null) return found;
        }
        return null;
    }

    private static String joinReasons(JSONArray value) {
        if (value == null) return "";
        ArrayList<String> reasons = new ArrayList<>();
        for (int i = 0; i < Math.min(value.length(), 8); i++) {
            String reason = bounded(value.optString(i, ""), 80);
            if (!reason.isEmpty()) reasons.add(reason);
        }
        return String.join(", ", reasons);
    }

    private static String requireChannel(String value) {
        String channel = safe(value).toLowerCase(Locale.US);
        if (!"stable".equals(channel) && !"preview".equals(channel)
                && !"candidate".equals(channel)) {
            throw new IllegalArgumentException("release channel is unsupported");
        }
        return channel;
    }

    private static String requireLineageKind(String value) {
        String kind = safe(value).toLowerCase(Locale.US);
        if (!List.of("root", "series", "parallel", "composed").contains(kind)) {
            throw new IllegalArgumentException("candidate lineage kind is invalid");
        }
        return kind;
    }

    private static String requireId(String value, String field) {
        String id = safe(value);
        if (!id.matches(ID)) throw new IllegalArgumentException(field + " is invalid");
        return id;
    }

    private static long requireSequence(long value) {
        if (value < 0L) throw new IllegalArgumentException("assignment sequence is invalid");
        return value;
    }

    private static String optionalId(String value) {
        String id = safe(value);
        return id.isEmpty() ? "" : requireId(id, "id");
    }

    private static boolean isHttpUrl(String value) {
        String lower = safe(value).toLowerCase(Locale.US);
        return lower.startsWith("https://") || lower.startsWith("http://");
    }

    private static String bounded(String value, int max) {
        String text = safe(value).replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", "");
        return text.length() <= max ? text : text.substring(0, max);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

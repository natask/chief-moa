package ag.companion;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public final class MoaReleaseSelectionPolicyTest {
    private static final String DIGEST = "a".repeat(64);

    @Test
    public void parsesSharedReleaseControlHttpFixture() throws Exception {
        JSONObject payload = sharedClientViews().getJSONObject("views").getJSONObject("android");

        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(payload);

        assertEquals("android-preview-2", view.assignment.releaseId);
        assertEquals("android-stable-1", view.stable.releaseId);
        assertEquals("android-preview-2", view.preview.releaseId);
        assertEquals("c".repeat(64), view.reportedInstalledSha256);
        assertTrue(view.hasLastKnownGood);
    }

    @Test
    public void parsesStablePreviewAndKeepsAssignmentSeparateFromInstall() throws Exception {
        JSONObject payload = new JSONObject()
                .put("schema_version", 1)
                .put("application_id", "chief-moa")
                .put("installed", installed())
                .put("effective_assignment", new JSONObject()
                        .put("assignment_id", "assignment-1")
                        .put("sequence", 7)
                        .put("source", "device")
                        .put("channel", "preview")
                        .put("bundle_id", "bundle-preview-2")
                        .put("release_id", "preview-2"))
                .put("channels", new JSONObject()
                        .put("stable", head("bundle-stable-1"))
                        .put("preview", head("bundle-preview-2")))
                .put("candidates", new JSONArray()
                        .put(candidate("stable", "stable-1", 10, true))
                        .put(candidate("preview", "preview-2", 11, true)));

        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(payload);

        assertEquals("preview", view.assignment.channel);
        assertEquals("stable-1", view.stable.releaseId);
        assertEquals("preview-2", view.preview.releaseId);
        assertTrue(view.preview.installable());
    }

    @Test
    public void incompatibleCandidateCannotBecomeAssignmentRequest() throws Exception {
        MoaReleaseSelectionPolicy.Candidate candidate =
                MoaReleaseSelectionPolicy.parseView(new JSONObject()
                        .put("schema_version", 1)
                        .put("application_id", "chief-moa")
                        .put("installed", installed())
                        .put("channels", new JSONObject().put("preview", head("bundle-preview-2")))
                        .put("candidates", new JSONArray()
                                .put(candidate("preview", "preview-2", 11, false))))
                        .preview;
        assertFalse(candidate.installable());
        try {
            MoaReleaseSelectionPolicy.assignmentRequest(
                    "android_1", "preview", candidate, 0L, "request-1");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("compatible"));
            return;
        }
        throw new AssertionError("Expected incompatible candidate rejection");
    }

    @Test
    public void feedbackBindsExactReleaseAndDigest() throws Exception {
        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(new JSONObject()
                .put("schema_version", 1)
                .put("application_id", "chief-moa")
                .put("installed", installed())
                .put("effective_assignment", assignment())
                .put("channels", new JSONObject().put("stable", head("bundle-stable-1")))
                .put("candidates", new JSONArray().put(candidate("stable", "stable-1", 10, true))));
        JSONObject body = MoaReleaseSelectionPolicy.feedbackRequest(
                "android_1", view.assignment, view.stable, "The button moved.", "feedback-1");
        assertEquals("stable-1", body.getString("release_id"));
        assertEquals(DIGEST, body.getString("artifact_sha256"));
        assertEquals("The button moved.", body.getString("text"));
        assertEquals("android", body.getString("surface"));
        assertEquals(0, body.getJSONArray("evidence_refs").length());
    }

    @Test
    public void installReceiptCannotClaimArbitraryState() throws Exception {
        MoaReleaseSelectionPolicy.Candidate candidate =
                MoaReleaseSelectionPolicy.parseView(new JSONObject()
                        .put("schema_version", 1)
                        .put("application_id", "chief-moa")
                        .put("installed", installed())
                        .put("effective_assignment", assignment())
                        .put("channels", new JSONObject().put("stable", head("bundle-stable-1")))
                        .put("candidates", new JSONArray().put(candidate("stable", "stable-1", 10, true))))
                        .stable;
        assertNotNull(MoaReleaseSelectionPolicy.installReceipt(
                "android_1", MoaReleaseSelectionPolicy.parseView(baseView()).assignment,
                candidate, "installer_opened", "", "receipt-1"));
        assertEquals("installer_opened", MoaReleaseSelectionPolicy.installReceipt(
                "android_1", MoaReleaseSelectionPolicy.parseView(baseView()).assignment,
                candidate, "installer_opened", "", "receipt-1").getString("status"));
        assertEquals("activated", MoaReleaseSelectionPolicy.installReceipt(
                "android_1", MoaReleaseSelectionPolicy.parseView(baseView()).assignment,
                candidate, "activated", "exact digest and version match", "receipt-activated-1")
                .getString("status"));
        try {
            MoaReleaseSelectionPolicy.installReceipt(
                    "android_1", MoaReleaseSelectionPolicy.parseView(baseView()).assignment,
                    candidate, "installed_automatically", "", "receipt-2");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("unsupported"));
            return;
        }
        throw new AssertionError("Expected unsupported receipt rejection");
    }

    @Test
    public void assignmentRequestCarriesSurfaceAndOptimisticSequence() throws Exception {
        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(baseView());
        JSONObject request = MoaReleaseSelectionPolicy.assignmentRequest(
                "android_1", "stable", view.stable, view.assignment.sequence, "assignment-2");
        assertEquals("android", request.getString("surface"));
        assertEquals(7L, request.getLong("expected_assignment_sequence"));
        assertEquals("bundle-stable-1", request.getString("bundle_id"));
    }

    @Test
    public void runningReleaseRequiresLocalDigestAndExactAssignmentAnchor() throws Exception {
        JSONObject payload = baseView();
        JSONObject installed = payload.getJSONObject("installed")
                .put("release_id", "stable-1")
                .put("artifact_sha256", DIGEST);
        payload.put("installed", installed);
        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(payload);
        assertTrue(MoaReleaseSelectionPolicy.exactRunningSelection(view, view.stable, DIGEST));
        assertFalse(MoaReleaseSelectionPolicy.exactRunningSelection(
                view, view.stable, "c".repeat(64)));

        payload.getJSONObject("effective_assignment").put("bundle_id", "other-bundle");
        MoaReleaseSelectionPolicy.View mismatched = MoaReleaseSelectionPolicy.parseView(payload);
        assertFalse(MoaReleaseSelectionPolicy.exactRunningSelection(
                mismatched, mismatched.stable, DIGEST));
    }

    @Test
    public void localDigestCanProveActivationWithoutFabricatingServerInstalledState() throws Exception {
        JSONObject payload = baseView().put("installed", JSONObject.NULL);
        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(payload);

        assertTrue(MoaReleaseSelectionPolicy.localMatchesAssignment(view, view.stable, DIGEST));
        assertFalse(MoaReleaseSelectionPolicy.exactRunningSelection(view, view.stable, DIGEST));
    }

    @Test
    public void rejectsMalformedArtifactAndUnboundedCandidateLists() throws Exception {
        JSONObject malformed = candidate("preview", "preview-2", 11, true);
        malformed.getJSONObject("artifact").put("sha256", "bad");
        try {
            MoaReleaseSelectionPolicy.parseView(new JSONObject()
                    .put("schema_version", 1)
                    .put("application_id", "chief-moa")
                    .put("installed", installed())
                    .put("channels", new JSONObject().put("preview", head("bundle-preview-2")))
                    .put("candidates", new JSONArray().put(malformed)));
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("artifact"));
        }

        JSONArray tooMany = new JSONArray();
        for (int i = 0; i < 33; i++) {
            tooMany.put(candidate("preview", "preview-" + i, 100 + i, true));
        }
        try {
            MoaReleaseSelectionPolicy.parseView(new JSONObject()
                    .put("schema_version", 1)
                    .put("application_id", "chief-moa")
                    .put("installed", installed())
                    .put("channels", new JSONObject())
                    .put("candidates", tooMany));
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("too large"));
            return;
        }
        throw new AssertionError("Expected candidate bound rejection");
    }

    @Test
    public void catalogRanksZeroOneAndManyWithSeriesAndParallelLineage() throws Exception {
        MoaReleaseSelectionPolicy.CatalogPage empty = MoaReleaseSelectionPolicy.parseCatalog(
                new JSONObject().put("schema_version", 1).put("candidates", new JSONArray()));
        assertTrue(empty.candidates.isEmpty());

        JSONObject series = catalogCandidate("bundle-series", "release-series", "series",
                "bundle-root", new JSONArray(), "0.2.0", "2026-07-25T00:00:00Z");
        JSONObject composed = catalogCandidate("bundle-composed", "release-composed", "composed",
                null, new JSONArray().put("bundle-a").put("bundle-b"), "0.3.0",
                "2026-07-26T00:00:00Z");
        MoaReleaseSelectionPolicy.CatalogPage page = MoaReleaseSelectionPolicy.parseCatalog(
                new JSONObject().put("schema_version", 1)
                        .put("candidates", new JSONArray().put(series).put(composed))
                        .put("next_cursor", "bundle-series"));
        assertEquals("bundle-series", page.nextCursor);
        assertEquals("series", page.candidates.get(0).relationLabel());
        assertEquals("parallel bundle", page.candidates.get(1).relationLabel());
        List<MoaReleaseSelectionPolicy.Candidate> ranked = MoaReleaseSelectionPolicy.rank(
                page.candidates, "parallel", "bundle-series", "");
        assertEquals(1, ranked.size());
        assertEquals("bundle-composed", ranked.get(0).bundleId);
        assertEquals("selected", MoaReleaseSelectionPolicy.coarseState(
                page.candidates.get(0), "bundle-series", ""));
    }

    @Test
    public void exactCandidateRequestCarriesBundleReleaseAndExpectedSequence() throws Exception {
        MoaReleaseSelectionPolicy.Candidate candidate = MoaReleaseSelectionPolicy.parseCatalog(
                new JSONObject().put("schema_version", 1).put("candidates", new JSONArray().put(
                        catalogCandidate("bundle-a", "release-a", "root", null,
                                new JSONArray(), "0.2.0", "2026-07-25T00:00:00Z"))))
                .candidates.get(0);
        JSONObject request = MoaReleaseSelectionPolicy.exactCandidateRequest(
                "android_1", candidate, 9L, "pick-a");
        assertEquals("bundle-a", request.getString("bundle_id"));
        assertEquals("release-a", request.getString("release_id"));
        assertEquals(9L, request.getLong("expected_assignment_sequence"));
        assertEquals("bundle-a", MoaReleaseSelectionPolicy.exactDeepLinkBundleId("bundle-a"));
        assertEquals("", MoaReleaseSelectionPolicy.exactDeepLinkBundleId("bundle-a?select=other"));
    }

    @Test
    public void staleSelectionDoesNotHideDeterministicFallback() throws Exception {
        MoaReleaseSelectionPolicy.View view = MoaReleaseSelectionPolicy.parseView(
                baseView().put("last_known_good", new JSONObject()
                        .put("assignment_id", "assignment-1")
                        .put("bundle_id", "bundle-stable-1")
                        .put("release_id", "stable-1")));
        assertTrue(view.hasLastKnownGood);
        JSONObject fallback = MoaReleaseSelectionPolicy.fallbackRequest(
                "android_1", view.assignment.sequence, "fallback-8");
        assertEquals(7L, fallback.getLong("expected_assignment_sequence"));
        assertEquals("android", fallback.getString("surface"));
    }

    private static JSONObject catalogCandidate(String bundleId, String releaseId, String kind,
                                               String seriesParent, JSONArray parallelParents,
                                               String version, String createdAt) throws Exception {
        JSONObject lineage = new JSONObject().put("kind", kind)
                .put("parallel_parent_bundle_ids", parallelParents);
        if (seriesParent == null) lineage.put("series_parent_bundle_id", JSONObject.NULL);
        else lineage.put("series_parent_bundle_id", seriesParent);
        return new JSONObject().put("bundle_id", bundleId).put("release_id", releaseId)
                .put("compatibility_version", 1).put("created_at", createdAt)
                .put("lineage", lineage)
                .put("artifact", new JSONObject().put("surface", "android")
                        .put("app_id", "ag.companion").put("version_code", 20)
                        .put("version_name", version).put("sha256", DIGEST)
                        .put("size_bytes", 1024).put("download_url", "https://api.example.test/a.apk"));
    }

    private static JSONObject candidate(
            String channel, String releaseId, long versionCode, boolean compatible) throws Exception {
        return new JSONObject()
                .put("release_id", releaseId)
                .put("bundle_id", "bundle-" + releaseId)
                .put("channel", channel)
                .put("source_ref", "master@abc123")
                .put("compatibility", new JSONObject()
                        .put("eligible", compatible)
                        .put("reasons", new JSONArray()))
                .put("artifact", new JSONObject()
                        .put("surface", "android")
                        .put("app_id", "ag.companion")
                        .put("version_code", versionCode)
                        .put("version_name", "0.1." + versionCode)
                        .put("sha256", DIGEST)
                        .put("size_bytes", 1024)
                        .put("download_url", "https://api.example.test/releases/" + releaseId + ".apk"));
    }

    private static JSONObject head(String bundleId) throws Exception {
        return new JSONObject().put("sequence", 1)
                .put("bundle", new JSONObject().put("bundle_id", bundleId));
    }

    private static JSONObject assignment() throws Exception {
        return new JSONObject().put("assignment_id", "assignment-1")
                .put("sequence", 7)
                .put("source", "device")
                .put("channel", "stable")
                .put("bundle_id", "bundle-stable-1")
                .put("release_id", "stable-1");
    }

    private static JSONObject baseView() throws Exception {
        return new JSONObject().put("schema_version", 1)
                .put("application_id", "chief-moa")
                .put("installed", installed())
                .put("effective_assignment", assignment())
                .put("channels", new JSONObject().put("stable", head("bundle-stable-1")))
                .put("candidates", new JSONArray().put(candidate("stable", "stable-1", 10, true)));
    }

    private static JSONObject installed() throws Exception {
        return new JSONObject().put("surface", "android")
                .put("release_id", "installed-1")
                .put("artifact_sha256", "b".repeat(64))
                .put("version_code", 9)
                .put("version_name", "0.1.9")
                .put("git_sha", "abc123")
                .put("status", "installed");
    }

    private static JSONObject sharedClientViews() throws Exception {
        try (InputStream input = MoaReleaseSelectionPolicyTest.class.getClassLoader()
                .getResourceAsStream("release-control-client-views-v1.json")) {
            if (input == null) throw new AssertionError("Shared release-control fixture is missing");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }
}

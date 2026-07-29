package ag.companion;

import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class MoaMediaSpotStoreTest {
    @Test
    public void preservesHonestBookmarkIdentityProvenance() {
        for (String provenance : new String[]{"canonical_uri", "session_media_id", "adapter_extracted"}) {
            MoaMediaSpotStore.Spot base = spot("id-" + provenance, provenance, "dQw4w9WgXcQ", 42_000L);
            MoaMediaSpotStore.Spot spot = new MoaMediaSpotStore.Spot(
                    base.id, base.label, base.note, base.title, base.packageName, base.instance,
                    base.mediaId, base.mediaUri, base.positionMs, base.durationMs, provenance,
                    base.createdAtMs, base.updatedAtMs, base.lastOpenedAtMs);
            assertEquals(provenance, MoaMediaSpotStore.deserialize(
                    MoaMediaSpotStore.serialize(List.of(spot))).get(0).identityStrength);
        }
    }

    @Test
    public void gatewayBookmarkIdIsAdditiveAndBackwardCompatible() {
        MoaMediaSpotStore.Spot base = spot("spot-remote", "Remote", "dQw4w9WgXcQ", 42_000L);
        assertEquals("", MoaMediaSpotStore.deserialize(
                MoaMediaSpotStore.serialize(List.of(base))).get(0).gatewayBookmarkId);
        MoaMediaSpotStore.Spot synced = base.withGatewayBookmarkId("bookmark_123");
        assertEquals("bookmark_123", MoaMediaSpotStore.deserialize(
                MoaMediaSpotStore.serialize(List.of(synced))).get(0).gatewayBookmarkId);
    }

    @Test
    public void serializationRoundTripPreservesVersionedAdditiveRecord() throws Exception {
        MoaMediaSpotStore.Spot spot = spot("spot-b", "Marawi part", "dQw4w9WgXcQ", 42_000L);
        String encoded = MoaMediaSpotStore.serialize(List.of(spot));
        JSONObject root = new JSONObject(encoded);
        JSONObject record = root.getJSONArray("spots").getJSONObject(0);

        assertEquals(1, root.getInt("version"));
        assertEquals("com.google.android.youtube", record.getString("package"));
        assertEquals("personal-profile", record.getString("instance"));
        assertEquals("dQw4w9WgXcQ", record.getString("media_id"));
        assertEquals("https://www.youtube.com/watch?v=dQw4w9WgXcQ", record.getString("media_uri"));
        assertEquals(42_000L, record.getLong("position"));

        record.put("future_additive_field", "ignored");
        List<MoaMediaSpotStore.Spot> decoded = MoaMediaSpotStore.deserialize(root.toString());
        assertEquals(1, decoded.size());
        assertEquals("Marawi part", decoded.get(0).label);
        assertEquals(Long.valueOf(1_700_000_003_000L), decoded.get(0).lastOpenedAtMs);
    }

    @Test
    public void persistenceShapeRejectsWeakOrNonYouTubeIdentity() {
        MoaMediaSpotStore.Spot invalidId = spot("bad", "Favorite", "too-short", 1L);
        assertThrows(IllegalArgumentException.class,
                () -> MoaMediaSpotStore.serialize(List.of(invalidId)));

        MoaMediaSpotStore.Spot weak = new MoaMediaSpotStore.Spot(
                "weak", "Favorite", "", "A title", "com.google.android.youtube", "",
                "dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                1L, 100L, "weak_title", 1_700_000_000_000L,
                1_700_000_001_000L, null);
        assertThrows(IllegalArgumentException.class,
                () -> MoaMediaSpotStore.serialize(List.of(weak)));
    }

    @Test
    public void exactLabelWinsOverPhraseAndTokenCandidates() {
        MoaMediaSpotStore.Spot exact = spot("a", "Marawi", "dQw4w9WgXcQ", 10L);
        MoaMediaSpotStore.Spot phrase = spot("b", "Marawi favorite scene", "9bZkp7q19f0", 20L);
        MoaMediaSpotStore.Spot token = spot("c", "Other", "J---aiyznGQ", 30L,
                "Marawi voice section", "Marawi documentary");

        MoaMediaSpotStore.Resolution result = MoaMediaSpotStore.resolve(
                List.of(token, phrase, exact), "Marawi");

        assertEquals(MoaMediaSpotStore.ResolutionStatus.MATCH, result.status);
        assertEquals(MoaMediaSpotStore.MatchType.EXACT_LABEL, result.matchType);
        assertEquals("a", result.spot.id);
    }

    @Test
    public void phraseContainmentWinsBeforeWeightedTokens() {
        MoaMediaSpotStore.Spot phrase = spot("phrase", "marketing voice", "dQw4w9WgXcQ", 10L);
        MoaMediaSpotStore.Spot tokens = spot("tokens", "marketing", "9bZkp7q19f0", 20L,
                "voice", "marketing voice analysis");

        MoaMediaSpotStore.Resolution result = MoaMediaSpotStore.resolve(
                List.of(tokens, phrase), "go back to the marketing voice part");

        assertEquals(MoaMediaSpotStore.ResolutionStatus.MATCH, result.status);
        assertEquals(MoaMediaSpotStore.MatchType.PHRASE_CONTAINMENT, result.matchType);
        assertEquals("phrase", result.spot.id);
    }

    @Test
    public void normalizedWeightedTokensResolveDeterministically() {
        MoaMediaSpotStore.Spot target = spot("target", "Café segment", "dQw4w9WgXcQ", 10L,
                "Campaign", "Product marketing review");
        MoaMediaSpotStore.Spot other = spot("other", "Opening", "9bZkp7q19f0", 20L,
                "instrumental", "Music video");

        MoaMediaSpotStore.Resolution result = MoaMediaSpotStore.resolve(
                List.of(other, target), "cafe campaign");

        assertEquals(MoaMediaSpotStore.ResolutionStatus.MATCH, result.status);
        assertEquals(MoaMediaSpotStore.MatchType.WEIGHTED_TOKENS, result.matchType);
        assertEquals("target", result.spot.id);
        assertTrue(result.score >= result.threshold);
    }

    @Test
    public void tiesAreExplicitlyAmbiguousAndSortedById() {
        MoaMediaSpotStore.Spot second = spot("spot-b", "chorus", "dQw4w9WgXcQ", 10L);
        MoaMediaSpotStore.Spot first = spot("spot-a", "chorus", "9bZkp7q19f0", 20L);

        MoaMediaSpotStore.Resolution result = MoaMediaSpotStore.resolve(
                List.of(second, first), "chorus");

        assertEquals(MoaMediaSpotStore.ResolutionStatus.AMBIGUOUS, result.status);
        assertEquals(MoaMediaSpotStore.MatchType.EXACT_LABEL, result.matchType);
        assertNull(result.spot);
        assertEquals(List.of("spot-a", "spot-b"),
                result.candidates.stream().map(item -> item.id).toList());
    }

    @Test
    public void belowThresholdAndEmptyQueriesAreExplicitlyNotFound() {
        MoaMediaSpotStore.Spot spot = spot("spot-a", "chorus", "dQw4w9WgXcQ", 10L);

        MoaMediaSpotStore.Resolution unrelated = MoaMediaSpotStore.resolve(
                List.of(spot), "tax accounting details");
        MoaMediaSpotStore.Resolution empty = MoaMediaSpotStore.resolve(List.of(spot), "  ");

        assertEquals(MoaMediaSpotStore.ResolutionStatus.NOT_FOUND, unrelated.status);
        assertEquals("below_token_threshold", unrelated.reason);
        assertEquals(MoaMediaSpotStore.ResolutionStatus.NOT_FOUND, empty.status);
        assertEquals("empty_query", empty.reason);
    }

    @Test
    public void deleteAndCreateRecoveryJournalsRejectCorruptionAndOverflow() {
        assertTrue(MoaMediaDeleteJournal.isStateHealthy(
                "[{\"local_id\":\"local_1\",\"gateway_id\":\"bookmark_1\"}]",
                "[\"local_1\"]"));
        assertEquals(false, MoaMediaDeleteJournal.isStateHealthy("{broken", "[]"));
        org.json.JSONArray overflow = new org.json.JSONArray();
        for (int i = 0; i <= MoaMediaDeleteJournal.MAX_RECORDS; i++) overflow.put("local_" + i);
        assertEquals(false, MoaMediaDeleteJournal.isStateHealthy("[]", overflow.toString()));
        java.util.ArrayList<String> full = new java.util.ArrayList<>();
        for (int i = 0; i < MoaMediaDeleteJournal.MAX_RECORDS; i++) full.add("local_" + i);
        assertEquals(false, MoaMediaDeleteJournal.canReserveSync(full, "new_local"));
        assertTrue(MoaMediaDeleteJournal.canReserveSync(full, "local_1"));
        List<MoaMediaDeleteJournal.Entry> pendingWithoutGateway = MoaMediaDeleteJournal.deserialize(
                "[{\"local_id\":\"local_1\",\"gateway_id\":\"\","
                        + "\"video_id\":\"dQw4w9WgXcQ\"}]");
        assertTrue(MoaMediaDeleteJournal.containsVideoId(
                pendingWithoutGateway, "dQw4w9WgXcQ"));
    }

    private static MoaMediaSpotStore.Spot spot(String id, String label, String mediaId, long position) {
        return spot(id, label, mediaId, position, "favorite section", "Example title");
    }

    private static MoaMediaSpotStore.Spot spot(
            String id,
            String label,
            String mediaId,
            long position,
            String note,
            String title
    ) {
        String uri = MoaMediaSpotStore.isValidYouTubeVideoId(mediaId)
                ? MoaMediaSpotStore.canonicalYouTubeWatchUri(mediaId)
                : "https://www.youtube.com/watch?v=" + mediaId;
        return new MoaMediaSpotStore.Spot(
                id, label, note, title, "com.google.android.youtube", "personal-profile",
                mediaId, uri, position, 300_000L, "canonical_uri",
                1_700_000_000_000L, 1_700_000_002_000L, 1_700_000_003_000L);
    }
}

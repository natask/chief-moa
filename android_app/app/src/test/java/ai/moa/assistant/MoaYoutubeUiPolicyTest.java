package ai.moa.assistant;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public final class MoaYoutubeUiPolicyTest {
    private static final long NOW = 1_000L;
    private static final long EXPIRES = NOW + 30_000L;

    @Test
    public void packageResolutionPrefersRevancedAndHonorsNamedOverride() {
        Set<String> installed = set(
                MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                MoaYoutubeUiPolicy.REVANCED_PACKAGE
        );

        assertEquals(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                MoaYoutubeUiPolicy.resolveExpectedPackage("", "advanced", installed)
        );
        assertEquals(
                MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                MoaYoutubeUiPolicy.resolveExpectedPackage("official", "advanced", installed)
        );
        assertEquals(
                "",
                MoaYoutubeUiPolicy.resolveExpectedPackage(
                        "official",
                        "advanced",
                        Collections.singleton(MoaYoutubeUiPolicy.REVANCED_PACKAGE)
                )
        );
    }

    @Test
    public void searchSelectsOneExactTitleAndChannelMatch() {
        MoaYoutubeUiPolicy.Observation initial = searchObservation(
                "search-1",
                candidate("a", "Android accessibility deep dive", "Moa Lab"),
                candidate("b", "Android accessibility deep dive", "Another Channel")
        );
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT,
                "Android accessibility deep dive",
                "Moa Lab",
                "",
                initial
        );

        MoaYoutubeUiPolicy.Decision decision = MoaYoutubeUiPolicy.evaluate(operation, initial, NOW);

        assertEquals(MoaYoutubeUiPolicy.Outcome.READY, decision.outcome);
        assertEquals(MoaYoutubeUiPolicy.Action.TAP_MATCHED_RESULT, decision.action);
        assertEquals("a", decision.targetLocalId);
    }

    @Test
    public void searchAcceptsOnlyUniqueHighConfidenceTitleWithExactChannel() {
        MoaYoutubeUiPolicy.Observation initial = searchObservation(
                "search-1",
                candidate("a", "Android accessibility deep dive policy guide tutorial", "Moa Lab")
        );
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT,
                "Android accessibility deep dive policy guide",
                "Moa Lab",
                "",
                initial
        );

        assertEquals(
                MoaYoutubeUiPolicy.Action.TAP_MATCHED_RESULT,
                MoaYoutubeUiPolicy.evaluate(operation, initial, NOW).action
        );
    }

    @Test
    public void searchWithoutChannelRequiresOneExactTitle() {
        MoaYoutubeUiPolicy.Observation unique = searchObservation(
                "search-1", candidate("a", "Exact Video", "Channel A"));
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT, "Exact Video", "", "", unique);
        assertEquals(MoaYoutubeUiPolicy.Action.TAP_MATCHED_RESULT,
                MoaYoutubeUiPolicy.evaluate(operation, unique, NOW).action);

        MoaYoutubeUiPolicy.Observation duplicates = searchObservation(
                "search-2", candidate("a", "Exact Video", "Channel A"),
                candidate("b", "Exact Video", "Channel B"));
        operation = begin(MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT,
                "Exact Video", "", "", duplicates);
        assertEquals(MoaYoutubeUiPolicy.Outcome.AMBIGUOUS,
                MoaYoutubeUiPolicy.evaluate(operation, duplicates, NOW).outcome);

        MoaYoutubeUiPolicy.Observation fuzzy = searchObservation(
                "search-3", candidate("a", "Exact Video extended", "Channel A"));
        operation = begin(MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT,
                "Exact Video", "", "", fuzzy);
        assertEquals(MoaYoutubeUiPolicy.Action.SCROLL_RESULTS,
                MoaYoutubeUiPolicy.evaluate(operation, fuzzy, NOW).action);
    }

    @Test
    public void searchFailsClosedOnAmbiguityAndFingerprintDrift() {
        MoaYoutubeUiPolicy.Observation initial = searchObservation(
                "search-1",
                candidate("a", "A Video", "A Channel"),
                candidate("b", "A Video", "A Channel")
        );
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT,
                "A Video",
                "A Channel",
                "",
                initial
        );

        assertEquals(
                MoaYoutubeUiPolicy.Outcome.AMBIGUOUS,
                MoaYoutubeUiPolicy.evaluate(operation, initial, NOW).outcome
        );
        MoaYoutubeUiPolicy.Observation drifted = searchObservation(
                "different-fingerprint",
                candidate("a", "A Video", "A Channel")
        );
        assertEquals(
                MoaYoutubeUiPolicy.Outcome.STALE_STATE,
                MoaYoutubeUiPolicy.evaluate(operation, drifted, NOW).outcome
        );
    }

    @Test
    public void searchStopsAfterBoundedScrolls() {
        MoaYoutubeUiPolicy.Observation observation = searchObservation("search-0");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT,
                "Missing Video",
                "Moa Lab",
                "",
                observation
        );

        for (int index = 0; index < MoaYoutubeUiPolicy.MAX_TRAVERSALS; index += 1) {
            MoaYoutubeUiPolicy.Decision decision = MoaYoutubeUiPolicy.evaluate(operation, observation, NOW);
            assertEquals(MoaYoutubeUiPolicy.Action.SCROLL_RESULTS, decision.action);
            observation = searchObservation("search-" + (index + 1));
            operation = MoaYoutubeUiPolicy.advance(operation, decision, observation);
            assertNotNull(operation);
        }

        assertEquals(
                MoaYoutubeUiPolicy.Outcome.LIMIT_REACHED,
                MoaYoutubeUiPolicy.evaluate(operation, observation, NOW).outcome
        );
    }

    @Test
    public void bookmarkUsesVersionedShareCopyLinkAndReturnsStableId() {
        MoaYoutubeUiPolicy.Observation watch = watchObservation("watch-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.CAPTURE_BOOKMARK_ID,
                "",
                "",
                "",
                watch
        );

        MoaYoutubeUiPolicy.Decision openShare = MoaYoutubeUiPolicy.evaluate(operation, watch, NOW);
        assertEquals(MoaYoutubeUiPolicy.Action.OPEN_SHARE, openShare.action);

        MoaYoutubeUiPolicy.Observation share = shareObservation("share-1", "");
        operation = MoaYoutubeUiPolicy.advance(operation, openShare, share);
        MoaYoutubeUiPolicy.Decision copy = MoaYoutubeUiPolicy.evaluate(operation, share, NOW);
        assertEquals(MoaYoutubeUiPolicy.Action.COPY_LINK, copy.action);

        MoaYoutubeUiPolicy.Observation copied = shareObservation(
                "share-2",
                "https://youtu.be/dQw4w9WgXcQ?t=43"
        );
        operation = MoaYoutubeUiPolicy.advance(operation, copy, copied);
        MoaYoutubeUiPolicy.Decision dismiss = MoaYoutubeUiPolicy.evaluate(operation, copied, NOW);
        assertEquals(MoaYoutubeUiPolicy.Action.DISMISS_SHARE, dismiss.action);
        assertEquals("dQw4w9WgXcQ", dismiss.videoId);
    }

    @Test
    public void bookmarkRefusesWeakOrForeignLinkIdentity() {
        assertEquals("", MoaYoutubeUiPolicy.extractVideoId("A title without an id"));
        assertEquals("", MoaYoutubeUiPolicy.extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ"));
        assertEquals("", MoaYoutubeUiPolicy.extractVideoId("https://youtube.com/watch?v=short"));
        assertEquals("dQw4w9WgXcQ", MoaYoutubeUiPolicy.extractVideoId(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"
        ));
        assertEquals("dQw4w9WgXcQ", MoaYoutubeUiPolicy.extractVideoId(
                "https://youtube.com/shorts/dQw4w9WgXcQ"
        ));
        assertEquals("dQw4w9WgXcQ", MoaYoutubeUiPolicy.extractCanonicalWatchVideoId(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3"));
        assertEquals("", MoaYoutubeUiPolicy.extractCanonicalWatchVideoId(
                "https://youtu.be/dQw4w9WgXcQ"));
        assertEquals("", MoaYoutubeUiPolicy.extractCanonicalWatchVideoId(
                "http://www.youtube.com/watch?v=dQw4w9WgXcQ"));

        MoaYoutubeUiPolicy.Observation share = shareObservation(
                "share-1",
                "https://youtube.com/watch?v=short"
        );
        MoaYoutubeUiPolicy.Operation operation = operationAtShare(share);
        assertEquals(
                MoaYoutubeUiPolicy.Outcome.UNSUPPORTED,
                MoaYoutubeUiPolicy.evaluate(operation, share, NOW).outcome
        );
    }

    @Test
    public void playlistMutationDoesNothingUntilBoundApprovalMatches() {
        MoaYoutubeUiPolicy.Observation watch = watchObservation("watch-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.ADD_TO_PLAYLIST,
                "",
                "",
                "Favorites",
                watch
        );

        assertEquals(
                MoaYoutubeUiPolicy.Outcome.NEEDS_APPROVAL,
                MoaYoutubeUiPolicy.evaluate(operation, watch, NOW).outcome
        );

        MoaYoutubeUiPolicy.Approval wrongDigest = new MoaYoutubeUiPolicy.Approval(
                "op-1", "wrong", MoaYoutubeUiPolicy.REVANCED_PACKAGE, EXPIRES, true
        );
        operation = MoaYoutubeUiPolicy.withApproval(operation, wrongDigest, NOW);
        assertEquals(
                MoaYoutubeUiPolicy.Outcome.NEEDS_APPROVAL,
                MoaYoutubeUiPolicy.evaluate(operation, watch, NOW).outcome
        );

        MoaYoutubeUiPolicy.Approval approval = new MoaYoutubeUiPolicy.Approval(
                "op-1", "digest-1", MoaYoutubeUiPolicy.REVANCED_PACKAGE, NOW + 5_000L, true
        );
        operation = MoaYoutubeUiPolicy.withApproval(operation, approval, NOW);
        assertEquals(
                MoaYoutubeUiPolicy.Action.OPEN_PLAYLIST_MENU,
                MoaYoutubeUiPolicy.evaluate(operation, watch, NOW).action
        );
    }

    @Test
    public void playlistPickerRequiresUniqueExactNameAndCurrentApproval() {
        MoaYoutubeUiPolicy.Observation watch = watchObservation("watch-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.REMOVE_FROM_PLAYLIST,
                "",
                "",
                "Favorites",
                watch
        );
        MoaYoutubeUiPolicy.Approval approval = new MoaYoutubeUiPolicy.Approval(
                "op-1", "digest-1", MoaYoutubeUiPolicy.REVANCED_PACKAGE, NOW + 5_000L, true
        );
        operation = MoaYoutubeUiPolicy.withApproval(operation, approval, NOW);
        MoaYoutubeUiPolicy.Decision open = MoaYoutubeUiPolicy.evaluate(operation, watch, NOW);

        MoaYoutubeUiPolicy.Observation picker = playlistObservation(
                "picker-1",
                candidate("p1", "Favorites", ""),
                candidate("p2", "Favorites", "")
        );
        operation = MoaYoutubeUiPolicy.advance(operation, open, picker);
        assertEquals(
                MoaYoutubeUiPolicy.Outcome.AMBIGUOUS,
                MoaYoutubeUiPolicy.evaluate(operation, picker, NOW).outcome
        );
        assertEquals(
                MoaYoutubeUiPolicy.Outcome.NEEDS_APPROVAL,
                MoaYoutubeUiPolicy.evaluate(operation, picker, NOW + 5_000L).outcome
        );
    }

    @Test
    public void playlistMembershipCompletesOnlyAfterExactCheckedEffect() {
        MoaYoutubeUiPolicy.Observation watch = watchObservation("watch-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.ADD_TO_PLAYLIST, "", "", "Favorites", watch);
        operation = MoaYoutubeUiPolicy.withApproval(operation,
                new MoaYoutubeUiPolicy.Approval("op-1", "digest-1",
                        MoaYoutubeUiPolicy.REVANCED_PACKAGE, NOW + 5_000L, true), NOW);
        MoaYoutubeUiPolicy.Decision open = MoaYoutubeUiPolicy.evaluate(operation, watch, NOW);
        MoaYoutubeUiPolicy.Observation picker = playlistObservation(
                "picker-1", playlistCandidate("p1", "Favorites", false));
        operation = MoaYoutubeUiPolicy.advance(operation, open, picker);
        MoaYoutubeUiPolicy.Decision select = MoaYoutubeUiPolicy.evaluate(operation, picker, NOW);
        assertEquals(MoaYoutubeUiPolicy.Action.SELECT_PLAYLIST, select.action);

        MoaYoutubeUiPolicy.Observation unchanged = playlistObservation(
                "picker-2", playlistCandidate("p1", "Favorites", false));
        MoaYoutubeUiPolicy.Operation verifying = MoaYoutubeUiPolicy.advance(operation, select, unchanged);
        assertEquals(MoaYoutubeUiPolicy.Outcome.UI_DRIFT,
                MoaYoutubeUiPolicy.evaluate(verifying, unchanged, NOW).outcome);

        MoaYoutubeUiPolicy.Observation changed = playlistObservation(
                "picker-3", playlistCandidate("p1", "Favorites", true));
        verifying = MoaYoutubeUiPolicy.advance(operation, select, changed);
        assertEquals(MoaYoutubeUiPolicy.Outcome.COMPLETE,
                MoaYoutubeUiPolicy.evaluate(verifying, changed, NOW).outcome);
    }

    @Test
    public void playlistPolicyRejectsWrongVideoAndNonCheckableFalsePositive() {
        MoaYoutubeUiPolicy.Observation watch = watchObservation("watch-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.REMOVE_FROM_PLAYLIST, "", "", "Favorites", watch);
        MoaYoutubeUiPolicy.Observation wrongVideo = new MoaYoutubeUiPolicy.Observation(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE, revancedVersion(),
                MoaYoutubeUiPolicy.Screen.WATCH, "watch-1",
                set("watch_root", "video_title", "share", "playlist_action"),
                Collections.emptyList(), "", "video:9bZkp7q19f0", 35);
        assertEquals(MoaYoutubeUiPolicy.Outcome.STALE_STATE,
                MoaYoutubeUiPolicy.evaluate(operation, wrongVideo, NOW).outcome);

        operation = MoaYoutubeUiPolicy.withApproval(operation,
                new MoaYoutubeUiPolicy.Approval("op-1", "digest-1",
                        MoaYoutubeUiPolicy.REVANCED_PACKAGE, NOW + 5_000L, true), NOW);
        MoaYoutubeUiPolicy.Decision open = MoaYoutubeUiPolicy.evaluate(operation, watch, NOW);
        MoaYoutubeUiPolicy.Observation picker = playlistObservation("picker-1",
                new MoaYoutubeUiPolicy.Candidate(
                        "p1", "Favorites", "", "candidate-p1", true, false, false));
        operation = MoaYoutubeUiPolicy.advance(operation, open, picker);
        assertEquals(MoaYoutubeUiPolicy.Action.SCROLL_PLAYLISTS,
                MoaYoutubeUiPolicy.evaluate(operation, picker, NOW).action);
    }

    @Test
    public void unsupportedProfileVersionAndOversizedTraversalFailClosed() {
        MoaYoutubeUiPolicy.Observation initial = searchObservation("search-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.OPEN_SEARCH_RESULT,
                "A Video",
                "A Channel",
                "",
                initial
        );
        MoaYoutubeUiPolicy.Observation wrongVersion = new MoaYoutubeUiPolicy.Observation(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                "unrecognized-ui-v9",
                MoaYoutubeUiPolicy.Screen.SEARCH_RESULTS,
                "search-1",
                set("search_results", "video_title", "channel_name"),
                Collections.emptyList(),
                "",
                20
        );
        assertEquals(
                MoaYoutubeUiPolicy.Outcome.UI_DRIFT,
                MoaYoutubeUiPolicy.evaluate(operation, wrongVersion, NOW).outcome
        );

        MoaYoutubeUiPolicy.Observation tooLarge = new MoaYoutubeUiPolicy.Observation(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                revancedVersion(),
                MoaYoutubeUiPolicy.Screen.SEARCH_RESULTS,
                "search-1",
                set("search_results", "video_title", "channel_name"),
                Collections.emptyList(),
                "",
                MoaYoutubeUiPolicy.MAX_OBSERVED_NODES + 1
        );
        assertEquals(
                MoaYoutubeUiPolicy.Outcome.LIMIT_REACHED,
                MoaYoutubeUiPolicy.evaluate(operation, tooLarge, NOW).outcome
        );
    }

    @Test
    public void advanceRejectsUnexpectedPackageOrScreen() {
        MoaYoutubeUiPolicy.Observation watch = watchObservation("watch-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.CAPTURE_BOOKMARK_ID,
                "",
                "",
                "",
                watch
        );
        MoaYoutubeUiPolicy.Decision open = MoaYoutubeUiPolicy.evaluate(operation, watch, NOW);

        assertNull(MoaYoutubeUiPolicy.advance(operation, open, searchObservation("search-1")));
    }

    private static MoaYoutubeUiPolicy.Operation operationAtShare(MoaYoutubeUiPolicy.Observation share) {
        MoaYoutubeUiPolicy.Observation watch = watchObservation("watch-1");
        MoaYoutubeUiPolicy.Operation operation = begin(
                MoaYoutubeUiPolicy.Kind.CAPTURE_BOOKMARK_ID,
                "",
                "",
                "",
                watch
        );
        MoaYoutubeUiPolicy.Decision open = MoaYoutubeUiPolicy.evaluate(operation, watch, NOW);
        return MoaYoutubeUiPolicy.advance(operation, open, share);
    }

    private static MoaYoutubeUiPolicy.Operation begin(
            MoaYoutubeUiPolicy.Kind kind,
            String title,
            String channel,
            String playlist,
            MoaYoutubeUiPolicy.Observation initial
    ) {
        return MoaYoutubeUiPolicy.begin(
                "op-1",
                kind,
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                "digest-1",
                title,
                channel,
                playlist,
                NOW,
                EXPIRES,
                initial
        );
    }

    private static MoaYoutubeUiPolicy.Candidate candidate(String id, String title, String channel) {
        return new MoaYoutubeUiPolicy.Candidate(id, title, channel, "candidate-" + id, true);
    }

    private static MoaYoutubeUiPolicy.Candidate playlistCandidate(
            String id, String title, boolean checked) {
        return new MoaYoutubeUiPolicy.Candidate(
                id, title, "", "candidate-" + id, true, true, checked);
    }

    private static MoaYoutubeUiPolicy.Observation searchObservation(
            String fingerprint,
            MoaYoutubeUiPolicy.Candidate... candidates
    ) {
        return new MoaYoutubeUiPolicy.Observation(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                revancedVersion(),
                MoaYoutubeUiPolicy.Screen.SEARCH_RESULTS,
                fingerprint,
                set("search_results", "video_title", "channel_name"),
                Arrays.asList(candidates),
                "",
                40
        );
    }

    private static MoaYoutubeUiPolicy.Observation watchObservation(String fingerprint) {
        return new MoaYoutubeUiPolicy.Observation(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                revancedVersion(),
                MoaYoutubeUiPolicy.Screen.WATCH,
                fingerprint,
                set("watch_root", "video_title", "share", "playlist_action"),
                Collections.emptyList(),
                "",
                "video:dQw4w9WgXcQ",
                35
        );
    }

    private static MoaYoutubeUiPolicy.Observation shareObservation(String fingerprint, String copiedLink) {
        return new MoaYoutubeUiPolicy.Observation(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                revancedVersion(),
                MoaYoutubeUiPolicy.Screen.SHARE,
                fingerprint,
                set("share_sheet", "copy_link"),
                Collections.emptyList(),
                copiedLink,
                25
        );
    }

    private static MoaYoutubeUiPolicy.Observation playlistObservation(
            String fingerprint,
            MoaYoutubeUiPolicy.Candidate... candidates
    ) {
        return new MoaYoutubeUiPolicy.Observation(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                revancedVersion(),
                MoaYoutubeUiPolicy.Screen.PLAYLIST_PICKER,
                fingerprint,
                set("playlist_picker", "playlist_name"),
                Arrays.asList(candidates),
                "",
                40
        );
    }

    private static String revancedVersion() {
        return MoaYoutubeUiPolicy.profileForPackage(MoaYoutubeUiPolicy.REVANCED_PACKAGE).version;
    }

    private static Set<String> set(String... values) {
        return new HashSet<>(Arrays.asList(values));
    }
}

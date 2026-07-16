package ai.moa.assistant;

import org.junit.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public final class MoaYoutubeAccessibilityExecutorTest {
    private static final long NOW = 1_000L;
    private static final String PACKAGE = MoaYoutubeUiPolicy.REVANCED_PACKAGE;

    @Test
    public void searchClicksOneHighConfidenceResultWithExactChannel() {
        SnapshotBuilder page = new SnapshotBuilder(3);
        page.add(node("scroll", "", "results", "", "", false, false, true, false));
        page.add(node("card", "scroll", "result", "", "", true, false, false, false));
        page.add(node("title", "card", "video_title",
                "Android accessibility deep dive policy guide tutorial", "", false, false, false, false));
        page.add(node("channel", "card", "channel_name", "Moa Lab", "", false, false, false, false));
        FakeDriver driver = new FakeDriver(page.build(), watch(4,
                "Android accessibility deep dive policy guide tutorial"));
        Capture callback = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.OPEN_SEARCH_RESULT,
                "Android accessibility deep dive policy guide", "Moa Lab", "", ""
        ));

        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, callback.result.outcome);
        assertEquals(Collections.singletonList("card"), driver.clicks);
    }

    @Test
    public void searchWithoutChannelClicksOnlyOneExactVisibleTitle() {
        SnapshotBuilder page = new SnapshotBuilder(3);
        page.add(node("scroll", "", "results", "", "", false, false, true, false));
        addResult(page, "a", "One exact video", "Channel A");
        FakeDriver unique = new FakeDriver(page.build(), watch(4, "One exact video"));
        Capture opened = run(unique, request(
                MoaYoutubeAccessibilityExecutor.Kind.OPEN_SEARCH_RESULT,
                "One exact video", "", "", ""));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, opened.result.outcome);
        assertEquals(Collections.singletonList("a"), unique.clicks);

        SnapshotBuilder duplicates = new SnapshotBuilder(5);
        duplicates.add(node("scroll", "", "results", "", "", false, false, true, false));
        addResult(duplicates, "a", "Same video", "Channel A");
        addResult(duplicates, "b", "Same video", "Channel B");
        Capture ambiguous = run(new FakeDriver(duplicates.build()), request(
                MoaYoutubeAccessibilityExecutor.Kind.OPEN_SEARCH_RESULT,
                "Same video", "", "", ""));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.AMBIGUOUS, ambiguous.result.outcome);
    }

    @Test
    public void searchFailsClosedWhenTwoExactResultsMatch() {
        SnapshotBuilder page = new SnapshotBuilder(3);
        page.add(node("scroll", "", "results", "", "", false, false, true, false));
        addResult(page, "a", "A video", "A channel");
        addResult(page, "b", "A video", "A channel");
        FakeDriver driver = new FakeDriver(page.build());
        Capture callback = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.OPEN_SEARCH_RESULT,
                "A video", "A channel", "", ""
        ));

        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.AMBIGUOUS, callback.result.outcome);
        assertTrue(driver.clicks.isEmpty());
    }

    @Test
    public void captureClicksShareThenCopyBeforeReadingClipboard() {
        FakeDriver driver = new FakeDriver(
                watch(7),
                snapshot(8, node("copy", "", "copy_link", "Copy link", "", true, false, false, false)),
                snapshot(9, node("copy", "", "copy_link", "Copy link", "", true, false, false, false))
        );
        driver.clipboard = "https://youtu.be/dQw4w9WgXcQ?t=43";
        driver.clipboardAfterCopy = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43";
        Capture callback = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID, "", "", "", ""
        ));

        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, callback.result.outcome);
        assertEquals("dQw4w9WgXcQ", callback.result.videoId);
        assertEquals(Arrays.asList("share", "copy"), driver.clicks);
        assertEquals(2, driver.clipboardReads);
        assertEquals(1, driver.backCount);
    }

    @Test
    public void officialYoutubeFixtureUsesTheSameBoundedSemanticFlow() {
        MoaYoutubeAccessibilityExecutor.Snapshot officialWatch = new MoaYoutubeAccessibilityExecutor.Snapshot(
                MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                5,
                Arrays.asList(node(
                        "share", "", "share_button", "Share", "", true, false, false, false
                ), node("title", "", "video_title", "A video", "", false, false, false, false))
        );
        MoaYoutubeAccessibilityExecutor.Snapshot officialShare = new MoaYoutubeAccessibilityExecutor.Snapshot(
                MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                6,
                Collections.singletonList(node(
                        "copy", "", "copy_link", "Copy link", "", true, false, false, false
                ))
        );
        MoaYoutubeAccessibilityExecutor.Snapshot officialCopied =
                new MoaYoutubeAccessibilityExecutor.Snapshot(
                        MoaYoutubeUiPolicy.OFFICIAL_PACKAGE, 7, officialShare.nodes);
        FakeDriver driver = new FakeDriver(officialWatch, officialShare, officialCopied);
        driver.clipboardAfterCopy = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        Capture callback = run(driver, new MoaYoutubeAccessibilityExecutor.Request(
                "official-op",
                MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID,
                MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                5,
                "", "", "", "",
                NOW + 30_000L
        ));

        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, callback.result.outcome);
        assertEquals("dQw4w9WgXcQ", callback.result.videoId);
    }

    @Test
    public void playlistAddUsesExactUncheckedPlaylistAndStops() {
        FakeDriver driver = new FakeDriver(
                watchWithSave(10),
                picker(11, false),
                picker(12, true)
        );
        Capture callback = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.ADD_TO_PLAYLIST, "A video", "", "Favorites", ""
        ));

        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, callback.result.outcome);
        assertEquals(Arrays.asList("save", "playlist-row"), driver.clicks);
    }

    @Test
    public void playlistRemoveRequiresObservedCheckedToUncheckedEffect() {
        FakeDriver driver = new FakeDriver(watchWithSave(10), picker(11, false));
        Capture callback = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.REMOVE_FROM_PLAYLIST, "A video", "", "Favorites", ""
        ));

        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.STALE_TARGET, callback.result.outcome);
        assertEquals(Collections.singletonList("save"), driver.clicks);

        FakeDriver checked = new FakeDriver(
                watchWithSave(20), picker(21, true), picker(22, false));
        Capture removed = run(checked, request(
                MoaYoutubeAccessibilityExecutor.Kind.REMOVE_FROM_PLAYLIST,
                "A video", "", "Favorites", ""));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, removed.result.outcome);
        assertEquals(Arrays.asList("save", "playlist-row"), checked.clicks);
    }

    @Test
    public void gatewayPlaylistRequestWithoutTitleBindsUniqueVisibleVideoEvidence() {
        FakeDriver driver = new FakeDriver(
                watchWithSave(10), picker(11, false), picker(12, true));
        Capture callback = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.ADD_TO_PLAYLIST,
                "", "", "Favorites", ""));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, callback.result.outcome);
    }

    @Test
    public void createPlaylistUsesFixedPickerDialogSetTextAndCreateFlow() {
        FakeDriver driver = new FakeDriver(
                watchWithSave(20),
                createPicker(21),
                snapshot(22,
                        node("name", "", "playlist_name", "", "Playlist name", false, true, false, false),
                        node("create", "", "create", "Create", "", true, false, false, false)),
                snapshot(23,
                        node("name", "", "playlist_name", "Road trip", "", false, true, false, false),
                        node("create", "", "create", "Create", "", true, false, false, false)),
                namedPicker(24, "Road trip", true)
        );
        Capture callback = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.CREATE_PLAYLIST, "A video", "", "Road trip", ""
        ));

        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, callback.result.outcome);
        assertEquals(Collections.singletonList("name=Road trip"), driver.textSets);
        assertEquals(Arrays.asList("save", "new", "create"), driver.clicks);
    }

    @Test
    public void renameAndDeleteUseOnlyTheirFixedMenuFlows() {
        FakeDriver rename = new FakeDriver(
                playlistPage(30),
                snapshot(31, node("rename", "", "rename", "Rename", "", true, false, false, false)),
                snapshot(32,
                        node("name", "", "playlist_name", "Favorites", "", false, true, false, false),
                        node("save-name", "", "save", "Save", "", true, false, false, false)),
                snapshot(33,
                        node("name", "", "playlist_name", "Keepers", "", false, true, false, false),
                        node("save-name", "", "save", "Save", "", true, false, false, false)),
                playlistPage(34, "Keepers")
        );
        Capture renamed = run(rename, request(
                MoaYoutubeAccessibilityExecutor.Kind.RENAME_PLAYLIST, "", "", "Favorites", "Keepers"
        ));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, renamed.result.outcome);
        assertEquals(Collections.singletonList("name=Keepers"), rename.textSets);
        assertEquals(Arrays.asList("more", "rename", "save-name"), rename.clicks);

        FakeDriver delete = new FakeDriver(
                playlistPage(40),
                snapshot(41, node("delete", "", "delete", "Delete", "", true, false, false, false)),
                snapshot(42, node("confirm", "", "confirm", "Delete", "", true, false, false, false)),
                snapshot(43,
                        node("library", "", "library", "Library", "", false, false, false, false),
                        node("deleted", "", "playlist_deleted", "Favorites", "", false, false, false, false))
        );
        Capture deleted = run(delete, request(
                MoaYoutubeAccessibilityExecutor.Kind.DELETE_PLAYLIST, "", "", "Favorites", ""
        ));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, deleted.result.outcome);
        assertEquals(Arrays.asList("more", "delete", "confirm"), delete.clicks);

        FakeDriver absenceOnly = new FakeDriver(playlistPage(50), deleteMenu(51),
                deleteDialog(52), snapshot(53,
                node("library", "", "library", "Library", "", false, false, false, false)));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, run(absenceOnly, request(
                MoaYoutubeAccessibilityExecutor.Kind.DELETE_PLAYLIST, "", "", "Favorites", ""
        )).result.outcome);
    }

    @Test
    public void packageChangeAndScrollLimitTerminateWithoutGuessing() {
        FakeDriver stale = new FakeDriver(new MoaYoutubeAccessibilityExecutor.Snapshot(
                MoaYoutubeUiPolicy.OFFICIAL_PACKAGE, 1, Collections.emptyList()));
        Capture staleResult = run(stale, request(
                MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID, "", "", "", ""
        ));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.STALE_TARGET, staleResult.result.outcome);

        FakeDriver bounded = new FakeDriver(
                emptySearch(2), emptySearch(3), emptySearch(4), emptySearch(5), emptySearch(6));
        Capture boundedResult = run(bounded, request(
                MoaYoutubeAccessibilityExecutor.Kind.OPEN_SEARCH_RESULT,
                "Missing", "Channel", "", ""
        ));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.LIMIT_REACHED, boundedResult.result.outcome);
        assertEquals(MoaYoutubeAccessibilityExecutor.MAX_SCROLLS, bounded.scrollCount);
    }

    @Test
    public void playlistVideoMutationsRejectWrongVideoBeforeAnyAction() {
        for (MoaYoutubeAccessibilityExecutor.Kind kind : Arrays.asList(
                MoaYoutubeAccessibilityExecutor.Kind.ADD_TO_PLAYLIST,
                MoaYoutubeAccessibilityExecutor.Kind.REMOVE_FROM_PLAYLIST,
                MoaYoutubeAccessibilityExecutor.Kind.CREATE_PLAYLIST)) {
            FakeDriver driver = new FakeDriver(watchWithSave(1, "Different video"));
            Capture result = run(driver, request(kind, "A video", "", "Favorites", ""));
            assertEquals(kind.name(), MoaYoutubeAccessibilityExecutor.Outcome.STALE_TARGET,
                    result.result.outcome);
            assertTrue(driver.clicks.isEmpty());
        }
    }

    @Test
    public void everyPlaylistOperationRejectsProfileDriftAtTheNextStep() {
        List<FakeDriver> drivers = Arrays.asList(
                new FakeDriver(watchWithSave(1), wrongVersion(picker(2, false))),
                new FakeDriver(watchWithSave(1), wrongVersion(picker(2, true))),
                new FakeDriver(watchWithSave(1), wrongVersion(createPicker(2))),
                new FakeDriver(playlistPage(1), wrongVersion(snapshot(2,
                        node("rename", "", "rename", "Rename", "", true, false, false, false)))),
                new FakeDriver(playlistPage(1), wrongVersion(snapshot(2,
                        node("delete", "", "delete", "Delete", "", true, false, false, false))))
        );
        List<MoaYoutubeAccessibilityExecutor.Kind> kinds = Arrays.asList(
                MoaYoutubeAccessibilityExecutor.Kind.ADD_TO_PLAYLIST,
                MoaYoutubeAccessibilityExecutor.Kind.REMOVE_FROM_PLAYLIST,
                MoaYoutubeAccessibilityExecutor.Kind.CREATE_PLAYLIST,
                MoaYoutubeAccessibilityExecutor.Kind.RENAME_PLAYLIST,
                MoaYoutubeAccessibilityExecutor.Kind.DELETE_PLAYLIST);
        for (int index = 0; index < kinds.size(); index++) {
            MoaYoutubeAccessibilityExecutor.Kind kind = kinds.get(index);
            String title = index < 3 ? "A video" : "";
            Capture result = run(drivers.get(index), request(
                    kind, title, "", "Favorites", kind == MoaYoutubeAccessibilityExecutor.Kind.RENAME_PLAYLIST
                            ? "Keepers" : ""));
            assertEquals(kind.name(), MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT,
                    result.result.outcome);
        }
    }

    @Test
    public void everyPlaylistOperationRejectsGenericTransitionFalsePositives() {
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, run(new FakeDriver(
                watchWithSave(1), picker(2, false), picker(3, false)), request(
                MoaYoutubeAccessibilityExecutor.Kind.ADD_TO_PLAYLIST,
                "A video", "", "Favorites", "")).result.outcome);
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, run(new FakeDriver(
                watchWithSave(1), picker(2, true), picker(3, true)), request(
                MoaYoutubeAccessibilityExecutor.Kind.REMOVE_FROM_PLAYLIST,
                "A video", "", "Favorites", "")).result.outcome);
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, run(new FakeDriver(
                watchWithSave(1), createPicker(2), createDialog(3, ""),
                createDialog(4, "Favorites"), namedPickerNonActionable(5, "Favorites")), request(
                MoaYoutubeAccessibilityExecutor.Kind.CREATE_PLAYLIST,
                "A video", "", "Favorites", "")).result.outcome);
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, run(new FakeDriver(
                playlistPage(1), renameMenu(2), renameDialog(3, "Favorites"),
                renameDialog(4, "Keepers"), playlistPageWithOldAndNew(5)), request(
                MoaYoutubeAccessibilityExecutor.Kind.RENAME_PLAYLIST,
                "", "", "Favorites", "Keepers")).result.outcome);
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, run(new FakeDriver(
                playlistPage(1), deleteMenu(2), deleteDialog(3), libraryWithPlaylist(4)), request(
                MoaYoutubeAccessibilityExecutor.Kind.DELETE_PLAYLIST,
                "", "", "Favorites", "")).result.outcome);
    }

    @Test
    public void clipboardCaptureRejectsStalePreloadButAcceptsSameContentNewGeneration() {
        String canonical = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        FakeDriver stale = new FakeDriver(watch(1), share(2), share(3), share(3), share(3));
        stale.clipboard = canonical;
        stale.clipboardAfterCopy = canonical;
        stale.clipboardGenerationAfterCopy = stale.clipboardGeneration;
        Capture staleResult = run(stale, request(
                MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID, "", "", "", ""));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, staleResult.result.outcome);

        FakeDriver freshGeneration = new FakeDriver(watch(1), share(2), share(3));
        freshGeneration.clipboard = canonical;
        freshGeneration.clipboardAfterCopy = canonical;
        freshGeneration.clipboardGeneration = 4L;
        freshGeneration.clipboardGenerationAfterCopy = 5L;
        Capture freshResult = run(freshGeneration, request(
                MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID, "", "", "", ""));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.COMPLETE, freshResult.result.outcome);
    }

    @Test
    public void clipboardCaptureRejectsFreshNonCanonicalYoutubeUrl() {
        FakeDriver driver = new FakeDriver(watch(1), share(2), share(3), share(3), share(3));
        driver.clipboardAfterCopy = "https://youtu.be/dQw4w9WgXcQ";
        Capture result = run(driver, request(
                MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID, "", "", "", ""));
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.UI_DRIFT, result.result.outcome);
    }

    @Test
    public void expiredRequestProducesOneTerminalCallbackWithoutUiAction() {
        FakeDriver driver = new FakeDriver(watch(1));
        Capture callback = new Capture();
        MoaYoutubeAccessibilityExecutor executor = new MoaYoutubeAccessibilityExecutor(
                new MoaYoutubeAccessibilityExecutor.Request(
                        "expired-op",
                        MoaYoutubeAccessibilityExecutor.Kind.CAPTURE_VIDEO_ID,
                        PACKAGE,
                        -1,
                        "", "", "", "",
                        NOW
                ),
                driver,
                callback
        );

        executor.start();
        executor.onAccessibilityEvent();
        driver.runAll();

        assertEquals(1, callback.calls);
        assertEquals(MoaYoutubeAccessibilityExecutor.Outcome.EXPIRED, callback.result.outcome);
        assertTrue(driver.clicks.isEmpty());
    }

    private static Capture run(FakeDriver driver, MoaYoutubeAccessibilityExecutor.Request request) {
        Capture callback = new Capture();
        new MoaYoutubeAccessibilityExecutor(request, driver, callback).start();
        driver.runAll();
        return callback;
    }

    private static MoaYoutubeAccessibilityExecutor.Request request(
            MoaYoutubeAccessibilityExecutor.Kind kind,
            String title,
            String channel,
            String playlist,
            String replacement
    ) {
        return new MoaYoutubeAccessibilityExecutor.Request(
                "op-1", kind, PACKAGE, -1, title, channel, playlist, replacement, NOW + 30_000L
        );
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot watch(int window) {
        return watch(window, "A video");
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot watch(int window, String title) {
        return snapshot(window,
                node("share", "", "share_button", "Share", "", true, false, false, false),
                node("title", "", "video_title", title, "", false, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot watchWithSave(int window) {
        return watchWithSave(window, "A video");
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot watchWithSave(int window, String title) {
        return snapshot(window,
                node("save", "", "save_to_playlist", "Save", "", true, false, false, false),
                node("title", "", "video_title", title, "", false, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot picker(int window, boolean checked) {
        return namedPicker(window, "Favorites", checked);
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot namedPicker(
            int window, String name, boolean checked) {
        return snapshot(window,
                node("scroll", "", "playlist_picker", "", "", false, false, true, false),
                node("playlist-row", "scroll", "playlist", "", "", true, false, false, false),
                node("playlist-name", "playlist-row", "playlist_name", name, "", false, false, false, false),
                node("playlist-check", "playlist-row", "checkbox", "", "", false, false, false, checked));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot createPicker(int window) {
        return snapshot(window,
                node("scroll", "", "playlist_picker", "", "", false, false, true, false),
                node("new", "scroll", "new_playlist", "New playlist", "", true, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot namedPickerNonActionable(
            int window, String name) {
        return snapshot(window,
                node("scroll", "", "playlist_picker", "", "", false, false, true, false),
                node("playlist-name", "scroll", "playlist_name", name, "", false, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot createDialog(int window, String value) {
        return snapshot(window,
                node("name", "", "playlist_name", value, value.isEmpty() ? "Playlist name" : "",
                        false, true, false, false),
                node("create", "", "create", "Create", "", true, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot renameMenu(int window) {
        return snapshot(window, node("rename", "", "rename", "Rename", "", true, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot deleteMenu(int window) {
        return snapshot(window, node("delete", "", "delete", "Delete", "", true, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot renameDialog(int window, String value) {
        return snapshot(window,
                node("name", "", "playlist_name", value, "", false, true, false, false),
                node("save-name", "", "save", "Save", "", true, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot deleteDialog(int window) {
        return snapshot(window, node("confirm", "", "confirm", "Delete", "", true, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot libraryWithPlaylist(int window) {
        return snapshot(window,
                node("library", "", "library", "Library", "", false, false, false, false),
                node("target", "", "playlist_name", "Favorites", "", false, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot playlistPageWithOldAndNew(int window) {
        return snapshot(window,
                node("more", "", "menu", "", "More actions", true, false, false, false),
                node("new", "", "playlist_title", "Keepers", "", false, false, false, false),
                node("old", "", "playlist_title", "Favorites", "", false, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot share(int window) {
        return snapshot(window, node("copy", "", "copy_link", "Copy link", "", true, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot emptySearch(int window) {
        return snapshot(window, node("scroll", "", "results", "", "", false, false, true, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot wrongVersion(
            MoaYoutubeAccessibilityExecutor.Snapshot source) {
        return new MoaYoutubeAccessibilityExecutor.Snapshot(
                source.packageName, "youtube-drifted-ui-v9", source.windowId, source.nodes);
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot playlistPage(int window) {
        return playlistPage(window, "Favorites");
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot playlistPage(int window, String title) {
        return snapshot(window,
                node("more", "", "menu", "", "More actions", true, false, false, false),
                node("playlist-title", "", "playlist_title", title, "", false, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Snapshot snapshot(
            int window,
            MoaYoutubeAccessibilityExecutor.Node... nodes
    ) {
        return new MoaYoutubeAccessibilityExecutor.Snapshot(PACKAGE, window, Arrays.asList(nodes));
    }

    private static void addResult(SnapshotBuilder builder, String id, String title, String channel) {
        builder.add(node(id, "scroll", "result", "", "", true, false, false, false));
        builder.add(node(id + "-title", id, "video_title", title, "", false, false, false, false));
        builder.add(node(id + "-channel", id, "channel_name", channel, "", false, false, false, false));
    }

    private static MoaYoutubeAccessibilityExecutor.Node node(
            String id,
            String parent,
            String resource,
            String text,
            String description,
            boolean clickable,
            boolean editable,
            boolean scrollable,
            boolean checked
    ) {
        return new MoaYoutubeAccessibilityExecutor.Node(
                id, parent, "app.revanced.android.youtube:id/" + resource,
                text, description, clickable, editable, scrollable, checked
        );
    }

    private static final class SnapshotBuilder {
        private final int window;
        private final List<MoaYoutubeAccessibilityExecutor.Node> nodes = new ArrayList<>();

        private SnapshotBuilder(int window) {
            this.window = window;
        }

        private void add(MoaYoutubeAccessibilityExecutor.Node node) {
            nodes.add(node);
        }

        private MoaYoutubeAccessibilityExecutor.Snapshot build() {
            return new MoaYoutubeAccessibilityExecutor.Snapshot(PACKAGE, window, nodes);
        }
    }

    private static final class Capture implements MoaYoutubeAccessibilityExecutor.Callback {
        private MoaYoutubeAccessibilityExecutor.Result result;
        private int calls;

        @Override
        public void onTerminal(MoaYoutubeAccessibilityExecutor.Result value) {
            result = value;
            calls++;
        }
    }

    private static final class FakeDriver implements MoaYoutubeAccessibilityExecutor.Driver {
        private final List<MoaYoutubeAccessibilityExecutor.Snapshot> snapshots;
        private final Deque<Runnable> scheduled = new ArrayDeque<>();
        private final List<String> clicks = new ArrayList<>();
        private final List<String> textSets = new ArrayList<>();
        private int index;
        private int clipboardReads;
        private int backCount;
        private int scrollCount;
        private String clipboard = "";
        private String clipboardAfterCopy = "";
        private long clipboardGeneration = 0L;
        private long clipboardGenerationAfterCopy = 1L;

        private FakeDriver(MoaYoutubeAccessibilityExecutor.Snapshot... snapshots) {
            this.snapshots = Arrays.asList(snapshots);
        }

        @Override
        public MoaYoutubeAccessibilityExecutor.Snapshot snapshot() {
            return snapshots.get(Math.min(index, snapshots.size() - 1));
        }

        @Override
        public boolean click(String localId) {
            clicks.add(localId);
            if ("copy".equals(localId)) {
                clipboard = clipboardAfterCopy;
                clipboardGeneration = clipboardGenerationAfterCopy;
            }
            index = Math.min(index + 1, snapshots.size() - 1);
            return true;
        }

        @Override
        public boolean setText(String localId, String value) {
            textSets.add(localId + "=" + value);
            index = Math.min(index + 1, snapshots.size() - 1);
            return true;
        }

        @Override
        public boolean scrollForward(String localId) {
            scrollCount++;
            index = Math.min(index + 1, snapshots.size() - 1);
            return true;
        }

        @Override
        public boolean back() {
            backCount++;
            return true;
        }

        @Override
        public String clipboardText() {
            clipboardReads++;
            return clipboard;
        }

        @Override
        public long clipboardGeneration() {
            return clipboardGeneration;
        }

        @Override
        public long nowMs() {
            return NOW;
        }

        @Override
        public void postDelayed(Runnable runnable, long delayMs) {
            scheduled.addLast(runnable);
        }

        private void runAll() {
            int guard = 100;
            while (!scheduled.isEmpty() && guard-- > 0) {
                scheduled.removeFirst().run();
            }
            assertTrue("executor did not quiesce", guard > 0);
        }
    }
}

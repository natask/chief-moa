package ai.moa.assistant;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Executes only the fixed YouTube UI flows declared here. The caller supplies
 * fresh, bounded snapshots and semantic node actions; requests cannot contain
 * selectors, coordinates, resource ids, or arbitrary action sequences.
 */
final class MoaYoutubeAccessibilityExecutor {
    static final int MAX_NODES = 160;
    static final int MAX_STEPS = 18;
    static final int MAX_SCROLLS = 4;
    static final long RETRY_DELAY_MS = 280L;

    enum Kind {
        OPEN_SEARCH_RESULT,
        CAPTURE_VIDEO_ID,
        ADD_TO_PLAYLIST,
        REMOVE_FROM_PLAYLIST,
        CREATE_PLAYLIST,
        RENAME_PLAYLIST,
        DELETE_PLAYLIST
    }

    enum Outcome {
        COMPLETE,
        EXPIRED,
        STALE_TARGET,
        UI_DRIFT,
        AMBIGUOUS,
        LIMIT_REACHED,
        ACTION_FAILED,
        UNSUPPORTED,
        CANCELLED
    }

    interface Callback {
        void onTerminal(Result result);
    }

    interface Driver {
        Snapshot snapshot();
        boolean click(String localId);
        boolean setText(String localId, String value);
        boolean scrollForward(String localId);
        boolean back();
        String clipboardText();
        default long clipboardGeneration() {
            return -1L;
        }
        long nowMs();
        void postDelayed(Runnable runnable, long delayMs);
    }

    static final class Request {
        final String operationId;
        final Kind kind;
        final String expectedPackage;
        final int initialWindowId;
        final String title;
        final String channel;
        final String playlist;
        final String replacementName;
        final String expectedProfileVersion;
        final String expectedVideoId;
        final String expectedVideoTitle;
        final String expectedMediaFingerprint;
        final boolean strongMediaBindingRequired;
        final long expiresAtMs;

        Request(
                String operationId,
                Kind kind,
                String expectedPackage,
                int initialWindowId,
                String title,
                String channel,
                String playlist,
                String replacementName,
                long expiresAtMs
        ) {
            this(operationId, kind, expectedPackage, initialWindowId, title, channel,
                    playlist, replacementName, profileVersion(expectedPackage), "", "", "",
                    false, expiresAtMs);
        }

        Request(
                String operationId,
                Kind kind,
                String expectedPackage,
                int initialWindowId,
                String title,
                String channel,
                String playlist,
                String replacementName,
                String expectedProfileVersion,
                String expectedVideoId,
                String expectedVideoTitle,
                String expectedMediaFingerprint,
                long expiresAtMs
        ) {
            this(operationId, kind, expectedPackage, initialWindowId, title, channel,
                    playlist, replacementName, expectedProfileVersion, expectedVideoId,
                    expectedVideoTitle, expectedMediaFingerprint, true, expiresAtMs);
        }

        private Request(
                String operationId,
                Kind kind,
                String expectedPackage,
                int initialWindowId,
                String title,
                String channel,
                String playlist,
                String replacementName,
                String expectedProfileVersion,
                String expectedVideoId,
                String expectedVideoTitle,
                String expectedMediaFingerprint,
                boolean strongMediaBindingRequired,
                long expiresAtMs
        ) {
            this.operationId = safe(operationId);
            this.kind = kind;
            this.expectedPackage = safe(expectedPackage);
            this.initialWindowId = initialWindowId;
            this.title = safe(title);
            this.channel = safe(channel);
            this.playlist = safe(playlist);
            this.replacementName = safe(replacementName);
            this.expectedProfileVersion = safe(expectedProfileVersion);
            this.expectedVideoId = safe(expectedVideoId);
            this.expectedVideoTitle = safe(expectedVideoTitle);
            this.expectedMediaFingerprint = safe(expectedMediaFingerprint);
            this.strongMediaBindingRequired = strongMediaBindingRequired;
            this.expiresAtMs = expiresAtMs;
        }
    }

    static final class Result {
        final String operationId;
        final Outcome outcome;
        final String videoId;
        final int steps;
        final String reason;

        Result(String operationId, Outcome outcome, String videoId, int steps, String reason) {
            this.operationId = safe(operationId);
            this.outcome = outcome;
            this.videoId = safe(videoId);
            this.steps = steps;
            this.reason = safe(reason);
        }
    }

    static final class Node {
        final String localId;
        final String parentId;
        final String resourceId;
        final String text;
        final String description;
        final boolean clickable;
        final boolean editable;
        final boolean scrollable;
        final boolean checked;

        Node(
                String localId,
                String parentId,
                String resourceId,
                String text,
                String description,
                boolean clickable,
                boolean editable,
                boolean scrollable,
                boolean checked
        ) {
            this.localId = safe(localId);
            this.parentId = safe(parentId);
            this.resourceId = safe(resourceId);
            this.text = safe(text);
            this.description = safe(description);
            this.clickable = clickable;
            this.editable = editable;
            this.scrollable = scrollable;
            this.checked = checked;
        }
    }

    static final class Snapshot {
        final String packageName;
        final String profileVersion;
        final String mediaVideoId;
        final String mediaTitle;
        final String mediaFingerprint;
        final int windowId;
        final List<Node> nodes;

        Snapshot(String packageName, int windowId, List<Node> nodes) {
            this(packageName, profileVersion(packageName), "", "", "", windowId, nodes);
        }

        Snapshot(String packageName, String profileVersion, int windowId, List<Node> nodes) {
            this(packageName, profileVersion, "", "", "", windowId, nodes);
        }

        Snapshot(
                String packageName,
                String profileVersion,
                String mediaVideoId,
                String mediaTitle,
                String mediaFingerprint,
                int windowId,
                List<Node> nodes
        ) {
            this.packageName = safe(packageName);
            this.profileVersion = safe(profileVersion);
            this.mediaVideoId = safe(mediaVideoId);
            this.mediaTitle = safe(mediaTitle);
            this.mediaFingerprint = safe(mediaFingerprint);
            this.windowId = windowId;
            this.nodes = nodes == null
                    ? Collections.emptyList()
                    : Collections.unmodifiableList(new ArrayList<>(nodes));
        }
    }

    private enum Phase {
        START,
        WAIT_SEARCH,
        WAIT_SHARE,
        WAIT_COPY,
        WAIT_WATCH_RETURN,
        WAIT_PICKER,
        WAIT_MEMBERSHIP_EFFECT,
        WAIT_CREATE_DIALOG,
        WAIT_CREATE_TEXT,
        WAIT_CREATE_COMMIT,
        WAIT_PLAYLIST_MENU,
        WAIT_RENAME_DIALOG,
        WAIT_RENAME_TEXT,
        WAIT_RENAME_COMMIT,
        WAIT_DELETE_DIALOG,
        WAIT_DELETE_COMMIT
    }

    private enum Screen {
        SEARCH_RESULTS,
        WATCH,
        SHARE,
        PLAYLIST_PICKER,
        CREATE_DIALOG,
        PLAYLIST_PAGE,
        PLAYLIST_MENU,
        RENAME_DIALOG,
        DELETE_DIALOG,
        LIBRARY
    }

    private final Request request;
    private final Driver driver;
    private final Callback callback;
    private Phase phase = Phase.START;
    private int steps;
    private int scrolls;
    private int unchangedSnapshots;
    private String lastFingerprint = "";
    private String transitionFingerprint = "";
    private String selectedSearchTitle = "";
    private Screen expectedScreen;
    private int expectedWindowId = -1;
    private String expectedFingerprint = "";
    private boolean awaitingTransition;
    private boolean copyClicked;
    private String clipboardBeforeCopy = "";
    private long clipboardGenerationBeforeCopy = -1L;
    private long clipboardObservedAtMs = -1L;
    private String boundVideoTitle = "";
    private String boundVideoChannel = "";
    private boolean terminal;
    private boolean pumping;
    private boolean membershipInitiallyChecked;

    MoaYoutubeAccessibilityExecutor(Request request, Driver driver, Callback callback) {
        this.request = request;
        this.driver = driver;
        this.callback = callback;
    }

    void start() {
        if (request != null && driver != null && request.expiresAtMs <= driver.nowMs()) {
            finish(Outcome.EXPIRED, "operation expired", "");
            return;
        }
        if (!validRequest()) {
            finish(Outcome.UNSUPPORTED, "invalid or unsupported fixed YouTube operation", "");
            return;
        }
        pump();
    }

    void onAccessibilityEvent() {
        if (!terminal) {
            driver.postDelayed(this::pump, 0L);
        }
    }

    void cancel() {
        finish(Outcome.CANCELLED, "operation cancelled", "");
    }

    private void pump() {
        if (terminal || pumping) {
            return;
        }
        pumping = true;
        try {
            if (driver.nowMs() >= request.expiresAtMs) {
                finish(Outcome.EXPIRED, "operation expired", "");
                return;
            }
            if (steps >= MAX_STEPS) {
                finish(Outcome.LIMIT_REACHED, "fixed operation step limit reached", "");
                return;
            }
            Snapshot snapshot = driver.snapshot();
            if (snapshot == null || snapshot.nodes.size() > MAX_NODES) {
                finish(snapshot == null ? Outcome.UI_DRIFT : Outcome.LIMIT_REACHED,
                        "bounded active-window snapshot unavailable", "");
                return;
            }
            if (!request.expectedPackage.equals(snapshot.packageName)) {
                finish(Outcome.STALE_TARGET, "active package changed", "");
                return;
            }
            MoaYoutubeUiPolicy.UiProfile profile =
                    MoaYoutubeUiPolicy.profileForPackage(request.expectedPackage);
            if (profile == null
                    || !request.expectedProfileVersion.equals(snapshot.profileVersion)) {
                finish(Outcome.UI_DRIFT, "unsupported package UI profile version", "");
                return;
            }
            if (phase == Phase.START && request.initialWindowId >= 0
                    && request.initialWindowId != snapshot.windowId) {
                finish(Outcome.STALE_TARGET, "initial window changed before execution", "");
                return;
            }
            String fingerprint = fingerprint(snapshot);
            unchangedSnapshots = fingerprint.equals(lastFingerprint) ? unchangedSnapshots + 1 : 0;
            lastFingerprint = fingerprint;
            Screen observedScreen = screenOf(snapshot);
            if (observedScreen == null) {
                finish(Outcome.UI_DRIFT, "versioned screen evidence is missing or ambiguous", "");
                return;
            }
            if (observedScreen == Screen.WATCH && request.strongMediaBindingRequired
                    && (!request.expectedVideoId.equals(snapshot.mediaVideoId)
                    || !normalize(request.expectedVideoTitle).equals(normalize(snapshot.mediaTitle))
                    || !request.expectedMediaFingerprint.equals(snapshot.mediaFingerprint))) {
                finish(Outcome.STALE_TARGET, "current media identity or fingerprint changed", "");
                return;
            }
            if (awaitingTransition) {
                if (observedScreen != expectedScreen) {
                    finish(Outcome.UI_DRIFT, "unexpected screen after fixed UI action", "");
                    return;
                }
                if (fingerprint.equals(transitionFingerprint)) {
                    if (unchangedSnapshots > 2) {
                        finish(Outcome.UI_DRIFT, "expected UI transition did not occur", "");
                    } else {
                        driver.postDelayed(this::pump, RETRY_DELAY_MS);
                    }
                    return;
                }
                bind(snapshot, observedScreen, fingerprint);
                awaitingTransition = false;
            } else if (expectedScreen == null) {
                bind(snapshot, observedScreen, fingerprint);
            } else if (observedScreen != expectedScreen
                    || snapshot.windowId != expectedWindowId
                    || !fingerprint.equals(expectedFingerprint)) {
                finish(Outcome.STALE_TARGET, "expected screen, window, or fingerprint changed", "");
                return;
            }
            evaluate(snapshot);
        } finally {
            pumping = false;
        }
    }

    private void evaluate(Snapshot snapshot) {
        switch (phase) {
            case START:
                startFlow(snapshot);
                break;
            case WAIT_SEARCH:
                selectSearchResult(snapshot);
                break;
            case WAIT_SHARE:
                openCopyLink(snapshot);
                break;
            case WAIT_COPY:
                readCopiedLink(snapshot);
                break;
            case WAIT_WATCH_RETURN:
                finishAfterTransition(snapshot);
                break;
            case WAIT_PICKER:
                handlePicker(snapshot);
                break;
            case WAIT_MEMBERSHIP_EFFECT:
                verifyMembershipEffect(snapshot);
                break;
            case WAIT_CREATE_DIALOG:
                fillName(snapshot, request.playlist, Phase.WAIT_CREATE_TEXT);
                break;
            case WAIT_CREATE_TEXT:
                commitName(snapshot, request.playlist, "create",
                        Phase.WAIT_CREATE_COMMIT, Screen.PLAYLIST_PICKER);
                break;
            case WAIT_PLAYLIST_MENU:
                openPlaylistMutation(snapshot);
                break;
            case WAIT_RENAME_DIALOG:
                fillName(snapshot, request.replacementName, Phase.WAIT_RENAME_TEXT);
                break;
            case WAIT_RENAME_TEXT:
                commitName(snapshot, request.replacementName, "save",
                        Phase.WAIT_RENAME_COMMIT, Screen.PLAYLIST_PAGE);
                break;
            case WAIT_DELETE_DIALOG:
                confirmDelete(snapshot);
                break;
            case WAIT_CREATE_COMMIT:
                verifyCreateEffect(snapshot);
                break;
            case WAIT_RENAME_COMMIT:
                verifyRenameEffect(snapshot);
                break;
            case WAIT_DELETE_COMMIT:
                verifyDeleteEffect(snapshot);
                break;
            default:
                finish(Outcome.UNSUPPORTED, "unknown fixed operation phase", "");
        }
    }

    private void startFlow(Snapshot snapshot) {
        Screen requiredInitial = request.kind == Kind.OPEN_SEARCH_RESULT
                ? Screen.SEARCH_RESULTS
                : request.kind == Kind.CAPTURE_VIDEO_ID
                || request.kind == Kind.ADD_TO_PLAYLIST
                || request.kind == Kind.REMOVE_FROM_PLAYLIST
                || request.kind == Kind.CREATE_PLAYLIST
                ? Screen.WATCH : Screen.PLAYLIST_PAGE;
        if (expectedScreen != requiredInitial) {
            finish(Outcome.UI_DRIFT, "operation started on an unexpected versioned screen", "");
            return;
        }
        if (request.kind == Kind.OPEN_SEARCH_RESULT) {
            phase = Phase.WAIT_SEARCH;
            selectSearchResult(snapshot);
        } else if (request.kind == Kind.CAPTURE_VIDEO_ID) {
            if (!request.title.isEmpty() && exactTextMatches(snapshot, request.title).size() != 1) {
                finish(Outcome.STALE_TARGET, "visible video title changed before capture", "");
                return;
            }
            clipboardBeforeCopy = safe(driver.clipboardText());
            clipboardGenerationBeforeCopy = driver.clipboardGeneration();
            clipboardObservedAtMs = driver.nowMs();
            clickUnique(snapshot, match("share", "share_button", "share"), Phase.WAIT_SHARE,
                    "Share action missing or ambiguous");
        } else if (request.kind == Kind.ADD_TO_PLAYLIST
                || request.kind == Kind.REMOVE_FROM_PLAYLIST
                || request.kind == Kind.CREATE_PLAYLIST) {
            if (!bindExactVideoEvidence(snapshot)) {
                finish(Outcome.STALE_TARGET, "visible video does not match the approved target", "");
                return;
            }
            clickUnique(snapshot, any(match("save", "save_to_playlist", "save"),
                            match("playlist", "playlist", "save to playlist")),
                    Phase.WAIT_PICKER, "playlist action missing or ambiguous");
        } else {
            phase = Phase.WAIT_PLAYLIST_MENU;
            openPlaylistMenu(snapshot);
        }
    }

    private void selectSearchResult(Snapshot snapshot) {
        List<Node> matches = searchMatches(snapshot);
        if (matches.size() > 1) {
            finish(Outcome.AMBIGUOUS, "multiple results match exact channel and title evidence", "");
        } else if (matches.size() == 1) {
            selectedSearchTitle = observedTitle(snapshot, matches.get(0));
            if (selectedSearchTitle.isEmpty()) {
                finish(Outcome.UI_DRIFT, "matched result had no observed title identity", "");
                return;
            }
            actClick(matches.get(0), Phase.WAIT_WATCH_RETURN, "matched result was not clickable");
        } else {
            scroll(snapshot, Phase.WAIT_SEARCH, "search result not found within scroll limit");
        }
    }

    private void openCopyLink(Snapshot snapshot) {
        clickUnique(snapshot, any(match("copy link", "copy_link", "copy link"),
                        match("copy", "copy", "copy")),
                Phase.WAIT_COPY, "Copy link action missing or ambiguous");
    }

    private void readCopiedLink(Snapshot snapshot) {
        if (!copyClicked) {
            finish(Outcome.ACTION_FAILED, "clipboard read was not preceded by Copy link", "");
            return;
        }
        String copied = safe(driver.clipboardText());
        long copiedGeneration = driver.clipboardGeneration();
        boolean fresh = clipboardGenerationBeforeCopy >= 0L
                && copiedGeneration > clipboardGenerationBeforeCopy;
        if (!fresh || clipboardObservedAtMs < 0L || driver.nowMs() < clipboardObservedAtMs) {
            retryOrFail("Copy link did not produce fresh clipboard evidence");
            return;
        }
        String videoId = MoaYoutubeUiPolicy.extractCanonicalWatchVideoId(copied);
        if (videoId.isEmpty()) {
            retryOrFail("Copy link did not expose a valid YouTube video id");
            return;
        }
        if (!driver.back()) {
            finish(Outcome.ACTION_FAILED, "could not dismiss Share sheet", "");
            return;
        }
        steps++;
        phase = Phase.WAIT_WATCH_RETURN;
        lastFingerprint = "video:" + videoId;
        finish(Outcome.COMPLETE, "stable YouTube video id captured", videoId);
    }

    private void handlePicker(Snapshot snapshot) {
        if (request.kind == Kind.CREATE_PLAYLIST) {
            clickUnique(snapshot, any(match("new playlist", "new_playlist", "new playlist"),
                            match("create playlist", "create_playlist", "create playlist")),
                    Phase.WAIT_CREATE_DIALOG, "New playlist action missing or ambiguous");
            return;
        }
        List<Node> matches = exactResourceTextMatches(snapshot, "playlist_name", request.playlist);
        if (matches.size() > 1) {
            finish(Outcome.AMBIGUOUS, "playlist name is not unique", "");
        } else if (matches.size() == 1) {
            Node target = clickableAncestor(snapshot, matches.get(0));
            if (target == null) {
                finish(Outcome.UI_DRIFT, "matched playlist is not actionable", "");
                return;
            }
            boolean wantedChecked = request.kind == Kind.ADD_TO_PLAYLIST;
            if (!subtreeHasCheckbox(snapshot, target.localId)) {
                finish(Outcome.UI_DRIFT, "matched playlist has no versioned checkbox evidence", "");
            } else if (request.kind == Kind.REMOVE_FROM_PLAYLIST
                    && !subtreeChecked(snapshot, target.localId)) {
                finish(Outcome.STALE_TARGET,
                        "remove requires observed checked membership before mutation", "");
            } else if (subtreeChecked(snapshot, target.localId) == wantedChecked) {
                finish(Outcome.COMPLETE, "playlist already has requested membership state", "");
            } else {
                membershipInitiallyChecked = subtreeChecked(snapshot, target.localId);
                actClick(target, Phase.WAIT_MEMBERSHIP_EFFECT, Screen.PLAYLIST_PICKER,
                        "playlist membership click failed");
            }
        } else {
            scroll(snapshot, Phase.WAIT_PICKER, "playlist not found within scroll limit");
        }
    }

    private void openPlaylistMenu(Snapshot snapshot) {
        if (exactResourceTextMatches(snapshot, "playlist_title", request.playlist).size() != 1) {
            finish(Outcome.STALE_TARGET, "visible playlist does not match the approved target", "");
            return;
        }
        clickUnique(snapshot, any(match("more", "menu", "more actions"),
                        match("more", "overflow", "more")),
                Phase.WAIT_PLAYLIST_MENU, "playlist More actions button missing or ambiguous");
    }

    private void openPlaylistMutation(Snapshot snapshot) {
        if (request.kind == Kind.RENAME_PLAYLIST) {
            clickUnique(snapshot, match("rename", "rename", "rename"), Phase.WAIT_RENAME_DIALOG,
                    "Rename action missing or ambiguous");
        } else {
            clickUnique(snapshot, match("delete", "delete", "delete"), Phase.WAIT_DELETE_DIALOG,
                    "Delete action missing or ambiguous");
        }
    }

    private void fillName(Snapshot snapshot, String value, Phase next) {
        List<Node> edits = matching(snapshot, node -> node.editable);
        if (edits.size() != 1) {
            finish(edits.size() > 1 ? Outcome.AMBIGUOUS : Outcome.UI_DRIFT,
                    "playlist name field missing or ambiguous", "");
            return;
        }
        if (!driver.setText(edits.get(0).localId, value)) {
            finish(Outcome.ACTION_FAILED, "could not set playlist name", "");
            return;
        }
        steps++;
        transitionFingerprint = lastFingerprint;
        phase = next;
        expectedScreen = next == Phase.WAIT_CREATE_TEXT
                ? Screen.CREATE_DIALOG : Screen.RENAME_DIALOG;
        awaitingTransition = true;
        driver.postDelayed(this::pump, RETRY_DELAY_MS);
    }

    private void commitName(
            Snapshot snapshot,
            String value,
            String commitLabel,
            Phase next,
            Screen terminalScreen
    ) {
        List<Node> edits = matching(snapshot, node -> node.editable
                && (normalize(node.text).equals(normalize(value))
                || normalize(node.description).equals(normalize(value))));
        if (edits.size() != 1) {
            finish(edits.size() > 1 ? Outcome.AMBIGUOUS : Outcome.UI_DRIFT,
                    "playlist name field did not retain the exact requested value", "");
            return;
        }
        clickUnique(snapshot, match(commitLabel, commitLabel, commitLabel), next, terminalScreen,
                "playlist commit action missing or ambiguous");
    }

    private void confirmDelete(Snapshot snapshot) {
        clickUnique(snapshot, any(match("delete", "confirm", "delete"),
                        match("delete", "delete", "delete playlist")),
                Phase.WAIT_DELETE_COMMIT, Screen.LIBRARY,
                "Delete confirmation missing or ambiguous");
    }

    private void verifyMembershipEffect(Snapshot snapshot) {
        List<Node> matches = exactResourceTextMatches(snapshot, "playlist_name", request.playlist);
        if (matches.size() != 1) {
            finish(matches.size() > 1 ? Outcome.AMBIGUOUS : Outcome.UI_DRIFT,
                    "exact playlist membership effect was not observable", "");
            return;
        }
        Node row = clickableAncestor(snapshot, matches.get(0));
        boolean wantedChecked = request.kind == Kind.ADD_TO_PLAYLIST;
        if (row == null || !subtreeHasCheckbox(snapshot, row.localId)
                || membershipInitiallyChecked == wantedChecked
                || subtreeChecked(snapshot, row.localId) != wantedChecked) {
            finish(Outcome.UI_DRIFT, "exact playlist membership state did not change", "");
            return;
        }
        finish(Outcome.COMPLETE, "exact playlist membership state observed", "");
    }

    private void verifyCreateEffect(Snapshot snapshot) {
        List<Node> matches = exactResourceTextMatches(snapshot, "playlist_name", request.playlist);
        Node row = matches.size() == 1 ? clickableAncestor(snapshot, matches.get(0)) : null;
        if (matches.size() != 1 || row == null || !hasResourceSuffix(row, "playlist")) {
            finish(matches.size() > 1 ? Outcome.AMBIGUOUS : Outcome.UI_DRIFT,
                    "created playlist was not uniquely observable", "");
            return;
        }
        finish(Outcome.COMPLETE, "created playlist observed in picker", "");
    }

    private void verifyRenameEffect(Snapshot snapshot) {
        if (exactResourceTextMatches(snapshot, "playlist_title", request.replacementName).size() != 1
                || !exactResourceTextMatches(snapshot, "playlist_title", request.playlist).isEmpty()) {
            finish(Outcome.UI_DRIFT, "exact playlist rename effect was not observable", "");
            return;
        }
        finish(Outcome.COMPLETE, "exact playlist rename effect observed", "");
    }

    private void verifyDeleteEffect(Snapshot snapshot) {
        if (!exactResourceTextMatches(snapshot, "playlist_name", request.playlist).isEmpty()) {
            finish(Outcome.UI_DRIFT, "deleted playlist is still visible", "");
            return;
        }
        List<Node> confirmations = exactResourceTextMatches(
                snapshot, "playlist_deleted", request.playlist);
        if (confirmations.size() != 1) {
            finish(Outcome.UI_DRIFT, "playlist absence was not a bound deletion confirmation", "");
            return;
        }
        finish(Outcome.COMPLETE, "bound playlist deletion confirmation observed", "");
    }

    private void finishAfterTransition(Snapshot snapshot) {
        if (fingerprint(snapshot).equals(transitionFingerprint)) {
            if (unchangedSnapshots > 2) {
                finish(Outcome.UI_DRIFT, "expected UI transition did not occur", "");
            } else {
                driver.postDelayed(this::pump, RETRY_DELAY_MS);
            }
            return;
        }
        if (!terminalScreenMatches(snapshot)) {
            finish(Outcome.UI_DRIFT, "unexpected screen after fixed UI action", "");
            return;
        }
        finish(Outcome.COMPLETE, "fixed YouTube UI operation completed", "");
    }

    private List<Node> searchMatches(Snapshot snapshot) {
        List<Node> titles = exactTextMatches(snapshot, request.title);
        if (titles.isEmpty() && !request.channel.isEmpty()) {
            titles = matching(snapshot, node -> tokenSimilarity(node.text, request.title) >= 0.85d
                    || tokenSimilarity(node.description, request.title) >= 0.85d);
        }
        List<Node> result = new ArrayList<>();
        for (Node title : titles) {
            Node action = clickableAncestor(snapshot, title);
            if (action != null && (request.channel.isEmpty()
                    || subtreeContains(snapshot, action.localId, request.channel))) {
                result.add(action);
            }
        }
        return uniqueById(result);
    }

    private void clickUnique(Snapshot snapshot, Matcher matcher, Phase next, String failure) {
        clickUnique(snapshot, matcher, next, expectedScreenFor(next), failure);
    }

    private void clickUnique(
            Snapshot snapshot, Matcher matcher, Phase next, Screen nextScreen, String failure) {
        List<Node> raw = matching(snapshot, matcher);
        List<Node> actions = new ArrayList<>();
        for (Node node : raw) {
            Node action = clickableAncestor(snapshot, node);
            if (action != null) {
                actions.add(action);
            }
        }
        actions = uniqueById(actions);
        if (actions.size() != 1) {
            finish(actions.size() > 1 ? Outcome.AMBIGUOUS : Outcome.UI_DRIFT, failure, "");
            return;
        }
        if (next == Phase.WAIT_COPY) {
            copyClicked = true;
        }
        actClick(actions.get(0), next, nextScreen, failure);
    }

    private void actClick(Node node, Phase next, String failure) {
        actClick(node, next, expectedScreenFor(next), failure);
    }

    private void actClick(Node node, Phase next, Screen nextScreen, String failure) {
        if (!driver.click(node.localId)) {
            finish(Outcome.ACTION_FAILED, failure, "");
            return;
        }
        steps++;
        transitionFingerprint = lastFingerprint;
        phase = next;
        expectedScreen = nextScreen;
        awaitingTransition = true;
        driver.postDelayed(this::pump, RETRY_DELAY_MS);
    }

    private void scroll(Snapshot snapshot, Phase next, String failure) {
        if (scrolls >= MAX_SCROLLS) {
            finish(Outcome.LIMIT_REACHED, failure, "");
            return;
        }
        List<Node> scrollables = matching(snapshot, node -> node.scrollable);
        if (scrollables.size() != 1 || !driver.scrollForward(scrollables.get(0).localId)) {
            finish(scrollables.size() > 1 ? Outcome.AMBIGUOUS : Outcome.UI_DRIFT,
                    "one bounded scroll container was not available", "");
            return;
        }
        steps++;
        scrolls++;
        phase = next;
        transitionFingerprint = lastFingerprint;
        expectedScreen = expectedScreenFor(next);
        awaitingTransition = true;
        driver.postDelayed(this::pump, RETRY_DELAY_MS);
    }

    private void retryOrFail(String reason) {
        if (unchangedSnapshots >= 2) {
            finish(Outcome.UI_DRIFT, reason, "");
        } else {
            driver.postDelayed(this::pump, RETRY_DELAY_MS);
        }
    }

    private boolean validRequest() {
        if (request == null || driver == null || callback == null
                || request.operationId.isEmpty() || request.kind == null
                || MoaYoutubeUiPolicy.profileForPackage(request.expectedPackage) == null
                || request.expectedProfileVersion.isEmpty()
                || request.expiresAtMs - driver.nowMs() > MoaYoutubeUiPolicy.MAX_OPERATION_LIFETIME_MS) {
            return false;
        }
        if (request.kind == Kind.OPEN_SEARCH_RESULT) {
            return !request.title.isEmpty();
        }
        if (request.strongMediaBindingRequired
                && (request.kind == Kind.ADD_TO_PLAYLIST
                || request.kind == Kind.REMOVE_FROM_PLAYLIST
                || request.kind == Kind.CREATE_PLAYLIST)
                && (!request.expectedVideoId.matches("[A-Za-z0-9_-]{11}")
                || request.expectedVideoTitle.isEmpty()
                || request.expectedMediaFingerprint.isEmpty())) {
            return false;
        }
        if (request.kind == Kind.ADD_TO_PLAYLIST || request.kind == Kind.REMOVE_FROM_PLAYLIST
                || request.kind == Kind.CREATE_PLAYLIST || request.kind == Kind.RENAME_PLAYLIST
                || request.kind == Kind.DELETE_PLAYLIST) {
            if (request.playlist.isEmpty()) {
                return false;
            }
        }
        return request.kind != Kind.RENAME_PLAYLIST || !request.replacementName.isEmpty();
    }

    private boolean bindExactVideoEvidence(Snapshot snapshot) {
        List<Node> titles = request.title.isEmpty()
                ? matching(snapshot, node -> hasResourceSuffix(node, "video_title")
                && !safe(node.text).isEmpty())
                : exactResourceTextMatches(snapshot, "video_title", request.title);
        List<Node> channels = request.channel.isEmpty()
                ? Collections.emptyList()
                : exactResourceTextMatches(snapshot, "channel_name", request.channel);
        if (titles.size() != 1 || (!request.channel.isEmpty() && channels.size() != 1)) {
            return false;
        }
        boundVideoTitle = safe(titles.get(0).text);
        boundVideoChannel = channels.isEmpty() ? "" : safe(channels.get(0).text);
        return !boundVideoTitle.isEmpty();
    }

    private void bind(Snapshot snapshot, Screen screen, String fingerprint) {
        expectedScreen = screen;
        expectedWindowId = snapshot.windowId;
        expectedFingerprint = fingerprint;
    }

    private static Screen expectedScreenFor(Phase next) {
        switch (next) {
            case WAIT_SEARCH: return Screen.SEARCH_RESULTS;
            case WAIT_SHARE: return Screen.SHARE;
            case WAIT_COPY: return Screen.SHARE;
            case WAIT_WATCH_RETURN: return Screen.WATCH;
            case WAIT_PICKER:
            case WAIT_MEMBERSHIP_EFFECT: return Screen.PLAYLIST_PICKER;
            case WAIT_CREATE_DIALOG: return Screen.CREATE_DIALOG;
            case WAIT_PLAYLIST_MENU: return Screen.PLAYLIST_MENU;
            case WAIT_RENAME_DIALOG: return Screen.RENAME_DIALOG;
            case WAIT_DELETE_DIALOG: return Screen.DELETE_DIALOG;
            default: return null;
        }
    }

    private static Screen screenOf(Snapshot snapshot) {
        boolean search = hasResource(snapshot, "results") || hasResource(snapshot, "search_results");
        boolean picker = hasResource(snapshot, "playlist_picker");
        boolean editable = matching(snapshot, node -> node.editable).size() == 1;
        boolean create = editable && hasResource(snapshot, "create");
        boolean rename = editable && hasResource(snapshot, "save");
        boolean delete = hasResource(snapshot, "confirm");
        boolean menu = (hasResource(snapshot, "rename") || hasResource(snapshot, "delete")) && !delete;
        boolean playlistPage = hasResource(snapshot, "playlist_title") && hasResource(snapshot, "menu");
        boolean library = hasResource(snapshot, "library");
        boolean share = hasResource(snapshot, "copy_link");
        boolean watch = hasResource(snapshot, "video_title")
                && (hasResource(snapshot, "share_button") || hasResource(snapshot, "save_to_playlist"));
        Screen[] screens = {search ? Screen.SEARCH_RESULTS : null, picker ? Screen.PLAYLIST_PICKER : null,
                create ? Screen.CREATE_DIALOG : null, rename ? Screen.RENAME_DIALOG : null,
                delete ? Screen.DELETE_DIALOG : null, menu ? Screen.PLAYLIST_MENU : null,
                playlistPage ? Screen.PLAYLIST_PAGE : null, library ? Screen.LIBRARY : null,
                share ? Screen.SHARE : null, watch ? Screen.WATCH : null};
        Screen found = null;
        for (Screen screen : screens) {
            if (screen == null) continue;
            if (found != null) return null;
            found = screen;
        }
        return found;
    }

    private static String profileVersion(String packageName) {
        MoaYoutubeUiPolicy.UiProfile profile = MoaYoutubeUiPolicy.profileForPackage(packageName);
        return profile == null ? "" : profile.version;
    }

    private boolean terminalScreenMatches(Snapshot snapshot) {
        if (request.kind == Kind.OPEN_SEARCH_RESULT) {
            return exactResourceTextMatches(snapshot, "video_title", selectedSearchTitle).size() == 1;
        }
        if (request.kind == Kind.ADD_TO_PLAYLIST
                || request.kind == Kind.REMOVE_FROM_PLAYLIST
                || request.kind == Kind.CREATE_PLAYLIST) {
            return hasResource(snapshot, "video_title")
                    && (hasResource(snapshot, "share_button") || hasResource(snapshot, "save_to_playlist"));
        }
        if (request.kind == Kind.RENAME_PLAYLIST) {
            return !exactTextMatches(snapshot, request.replacementName).isEmpty();
        }
        if (request.kind == Kind.DELETE_PLAYLIST) {
            return exactTextMatches(snapshot, request.playlist).isEmpty();
        }
        return true;
    }

    private static String observedTitle(Snapshot snapshot, Node action) {
        for (Node node : snapshot.nodes) {
            if ((node.localId.equals(action.localId) || isDescendantOf(snapshot, node, action.localId))
                    && hasResourceSuffix(node, "video_title") && !safe(node.text).isEmpty()) {
                return safe(node.text);
            }
        }
        return "";
    }

    private static boolean isDescendantOf(Snapshot snapshot, Node node, String ancestorId) {
        String parent = node.parentId;
        for (int depth = 0; depth < 8 && !parent.isEmpty(); depth++) {
            if (parent.equals(ancestorId)) return true;
            Node found = null;
            for (Node candidate : snapshot.nodes) if (candidate.localId.equals(parent)) found = candidate;
            if (found == null) return false;
            parent = found.parentId;
        }
        return false;
    }

    private void finish(Outcome outcome, String reason, String videoId) {
        if (terminal) {
            return;
        }
        terminal = true;
        callback.onTerminal(new Result(request == null ? "" : request.operationId,
                outcome, videoId, steps, reason));
    }

    private static List<Node> exactTextMatches(Snapshot snapshot, String value) {
        String target = normalize(value);
        return matching(snapshot, node -> normalize(node.text).equals(target)
                || normalize(node.description).equals(target));
    }

    private static List<Node> exactResourceTextMatches(
            Snapshot snapshot, String resourceSuffix, String value) {
        String target = normalize(value);
        return matching(snapshot, node -> hasResourceSuffix(node, resourceSuffix)
                && (normalize(node.text).equals(target)
                || normalize(node.description).equals(target)));
    }

    private static boolean hasResource(Snapshot snapshot, String suffix) {
        String wanted = normalizeResource(suffix);
        for (Node node : snapshot.nodes) {
            if (normalizeResource(node.resourceId).endsWith(wanted)) {
                return true;
            }
        }
        return false;
    }

    private static boolean hasResourceSuffix(Node node, String suffix) {
        return normalizeResource(node.resourceId).endsWith(normalizeResource(suffix));
    }

    private static boolean subtreeContains(Snapshot snapshot, String rootId, String text) {
        String target = normalize(text);
        Set<String> descendants = descendantIds(snapshot, rootId);
        for (Node node : snapshot.nodes) {
            if (descendants.contains(node.localId)
                    && (normalize(node.text).equals(target) || normalize(node.description).equals(target))) {
                return true;
            }
        }
        return false;
    }

    private static boolean subtreeChecked(Snapshot snapshot, String rootId) {
        Set<String> descendants = descendantIds(snapshot, rootId);
        for (Node node : snapshot.nodes) {
            if (descendants.contains(node.localId) && node.checked) {
                return true;
            }
        }
        return false;
    }

    private static boolean subtreeHasCheckbox(Snapshot snapshot, String rootId) {
        Set<String> descendants = descendantIds(snapshot, rootId);
        for (Node node : snapshot.nodes) {
            if (descendants.contains(node.localId) && hasResourceSuffix(node, "checkbox")) {
                return true;
            }
        }
        return false;
    }

    private static Set<String> descendantIds(Snapshot snapshot, String rootId) {
        Set<String> descendants = new HashSet<>();
        descendants.add(rootId);
        for (int pass = 0; pass < 8; pass++) {
            for (Node node : snapshot.nodes) {
                if (descendants.contains(node.parentId)) {
                    descendants.add(node.localId);
                }
            }
        }
        return descendants;
    }

    private static Node clickableAncestor(Snapshot snapshot, Node node) {
        Node current = node;
        for (int depth = 0; current != null && depth < 8; depth++) {
            if (current.clickable) {
                return current;
            }
            current = findById(snapshot, current.parentId);
        }
        return null;
    }

    private static Node findById(Snapshot snapshot, String localId) {
        for (Node node : snapshot.nodes) {
            if (node.localId.equals(localId)) {
                return node;
            }
        }
        return null;
    }

    private interface Matcher {
        boolean matches(Node node);
    }

    private static Matcher match(String text, String resourceSuffix, String description) {
        String wantedText = normalize(text);
        String wantedDescription = normalize(description);
        String wantedResource = normalizeResource(resourceSuffix);
        return node -> normalize(node.text).equals(wantedText)
                || normalize(node.description).equals(wantedDescription)
                || normalizeResource(node.resourceId).endsWith(wantedResource);
    }

    private static Matcher any(Matcher left, Matcher right) {
        return node -> left.matches(node) || right.matches(node);
    }

    private static List<Node> matching(Snapshot snapshot, Matcher matcher) {
        List<Node> matches = new ArrayList<>();
        for (Node node : snapshot.nodes) {
            if (!node.localId.isEmpty() && matcher.matches(node)) {
                matches.add(node);
            }
        }
        return matches;
    }

    private static List<Node> uniqueById(List<Node> nodes) {
        List<Node> result = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (Node node : nodes) {
            if (ids.add(node.localId)) {
                result.add(node);
            }
        }
        return result;
    }

    private static String fingerprint(Snapshot snapshot) {
        StringBuilder value = new StringBuilder(snapshot.packageName).append(':').append(snapshot.windowId);
        for (Node node : snapshot.nodes) {
            value.append('|').append(node.localId).append(':').append(node.resourceId)
                    .append(':').append(node.text).append(':').append(node.description)
                    .append(':').append(node.checked);
        }
        return Integer.toHexString(value.toString().hashCode());
    }

    private static String normalize(String value) {
        return safe(value).toLowerCase(Locale.US).replaceAll("[^a-z0-9]+", " ")
                .replaceAll("\\s+", " ").trim();
    }

    private static String normalizeResource(String value) {
        return safe(value).toLowerCase(Locale.US).replace('-', '_');
    }

    private static double tokenSimilarity(String left, String right) {
        Set<String> leftTokens = tokens(left);
        Set<String> rightTokens = tokens(right);
        if (leftTokens.isEmpty() || rightTokens.isEmpty()) {
            return 0d;
        }
        Set<String> intersection = new HashSet<>(leftTokens);
        intersection.retainAll(rightTokens);
        Set<String> union = new HashSet<>(leftTokens);
        union.addAll(rightTokens);
        return (double) intersection.size() / (double) union.size();
    }

    private static Set<String> tokens(String value) {
        Set<String> result = new HashSet<>();
        Collections.addAll(result, normalize(value).split(" "));
        result.remove("");
        return result;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

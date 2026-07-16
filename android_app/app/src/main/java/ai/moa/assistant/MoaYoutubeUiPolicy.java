package ai.moa.assistant;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure policy for a future package-bound YouTube Accessibility adapter.
 *
 * <p>This class deliberately returns semantic actions. It never accepts a
 * model-authored node id, coordinate, selector, or tap sequence. The Android
 * adapter must translate a semantic action using a versioned {@link UiProfile},
 * capture a fresh observation, and call {@link #advance} before evaluating the
 * next state.</p>
 */
final class MoaYoutubeUiPolicy {
    static final int MAX_OBSERVED_NODES = 160;
    static final int MAX_TRAVERSALS = 4;
    static final long MAX_OPERATION_LIFETIME_MS = 2 * 60 * 1000L;

    static final String OFFICIAL_PACKAGE = "com.google.android.youtube";
    static final String REVANCED_PACKAGE = "app.revanced.android.youtube";

    private static final Pattern VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final Map<String, UiProfile> PROFILES = createProfiles();
    private static final Map<String, String> PACKAGE_ALIASES = createAliases();

    private MoaYoutubeUiPolicy() {
    }

    enum Kind {
        OPEN_SEARCH_RESULT,
        CAPTURE_BOOKMARK_ID,
        ADD_TO_PLAYLIST,
        REMOVE_FROM_PLAYLIST
    }

    enum Phase {
        SEARCH_RESULT,
        BOOKMARK_OPEN_SHARE,
        BOOKMARK_COPY_LINK,
        BOOKMARK_RETURN,
        PLAYLIST_OPEN_MENU,
        PLAYLIST_PICKER,
        PLAYLIST_VERIFY,
        DONE
    }

    enum Screen {
        SEARCH_RESULTS,
        WATCH,
        SHARE,
        PLAYLIST_PICKER
    }

    enum Action {
        NONE,
        TAP_MATCHED_RESULT,
        SCROLL_RESULTS,
        OPEN_SHARE,
        COPY_LINK,
        DISMISS_SHARE,
        OPEN_PLAYLIST_MENU,
        SELECT_PLAYLIST,
        SCROLL_PLAYLISTS
    }

    enum Outcome {
        READY,
        NEEDS_APPROVAL,
        COMPLETE,
        AMBIGUOUS,
        EXPIRED,
        STALE_STATE,
        UI_DRIFT,
        LIMIT_REACHED,
        UNSUPPORTED
    }

    static final class UiProfile {
        final String packageName;
        final String variant;
        final String version;
        private final Map<Screen, Set<String>> requiredEvidence;

        private UiProfile(
                String packageName,
                String variant,
                String version,
                Map<Screen, Set<String>> requiredEvidence
        ) {
            this.packageName = packageName;
            this.variant = variant;
            this.version = version;
            this.requiredEvidence = requiredEvidence;
        }

        Set<String> requiredEvidence(Screen screen) {
            Set<String> values = requiredEvidence.get(screen);
            return values == null ? Collections.emptySet() : values;
        }
    }

    static final class Candidate {
        final String localId;
        final String title;
        final String channel;
        final String fingerprint;
        final boolean actionable;
        final boolean checkable;
        final boolean checked;

        Candidate(String localId, String title, String channel, String fingerprint, boolean actionable) {
            this(localId, title, channel, fingerprint, actionable, true, false);
        }

        Candidate(
                String localId,
                String title,
                String channel,
                String fingerprint,
                boolean actionable,
                boolean checked
        ) {
            this(localId, title, channel, fingerprint, actionable, true, checked);
        }

        Candidate(
                String localId,
                String title,
                String channel,
                String fingerprint,
                boolean actionable,
                boolean checkable,
                boolean checked
        ) {
            this.localId = safe(localId);
            this.title = safe(title);
            this.channel = safe(channel);
            this.fingerprint = safe(fingerprint);
            this.actionable = actionable;
            this.checkable = checkable;
            this.checked = checked;
        }
    }

    static final class Observation {
        final String packageName;
        final String profileVersion;
        final Screen screen;
        final String fingerprint;
        final Set<String> evidence;
        final List<Candidate> candidates;
        final String copiedLink;
        final String mediaIdentity;
        final int observedNodeCount;

        Observation(
                String packageName,
                String profileVersion,
                Screen screen,
                String fingerprint,
                Set<String> evidence,
                List<Candidate> candidates,
                String copiedLink,
                int observedNodeCount
        ) {
            this(packageName, profileVersion, screen, fingerprint, evidence,
                    candidates, copiedLink, "", observedNodeCount);
        }

        Observation(
                String packageName,
                String profileVersion,
                Screen screen,
                String fingerprint,
                Set<String> evidence,
                List<Candidate> candidates,
                String copiedLink,
                String mediaIdentity,
                int observedNodeCount
        ) {
            this.packageName = safe(packageName);
            this.profileVersion = safe(profileVersion);
            this.screen = screen;
            this.fingerprint = safe(fingerprint);
            this.evidence = immutableSet(evidence);
            this.candidates = candidates == null
                    ? Collections.emptyList()
                    : Collections.unmodifiableList(new ArrayList<>(candidates));
            this.copiedLink = safe(copiedLink);
            this.mediaIdentity = safe(mediaIdentity);
            this.observedNodeCount = observedNodeCount;
        }
    }

    static final class Approval {
        final String operationId;
        final String argumentDigest;
        final String packageName;
        final long expiresAtMs;
        final boolean approved;

        Approval(
                String operationId,
                String argumentDigest,
                String packageName,
                long expiresAtMs,
                boolean approved
        ) {
            this.operationId = safe(operationId);
            this.argumentDigest = safe(argumentDigest);
            this.packageName = safe(packageName);
            this.expiresAtMs = expiresAtMs;
            this.approved = approved;
        }
    }

    static final class Operation {
        final String operationId;
        final Kind kind;
        final String expectedPackage;
        final String argumentDigest;
        final String title;
        final String channel;
        final String playlist;
        final String expectedMediaIdentity;
        final long expiresAtMs;
        final Phase phase;
        final Screen expectedScreen;
        final String expectedFingerprint;
        final int traversals;
        final Approval approval;

        private Operation(
                String operationId,
                Kind kind,
                String expectedPackage,
                String argumentDigest,
                String title,
                String channel,
                String playlist,
                String expectedMediaIdentity,
                long expiresAtMs,
                Phase phase,
                Screen expectedScreen,
                String expectedFingerprint,
                int traversals,
                Approval approval
        ) {
            this.operationId = safe(operationId);
            this.kind = kind;
            this.expectedPackage = safe(expectedPackage);
            this.argumentDigest = safe(argumentDigest);
            this.title = safe(title);
            this.channel = safe(channel);
            this.playlist = safe(playlist);
            this.expectedMediaIdentity = safe(expectedMediaIdentity);
            this.expiresAtMs = expiresAtMs;
            this.phase = phase;
            this.expectedScreen = expectedScreen;
            this.expectedFingerprint = safe(expectedFingerprint);
            this.traversals = traversals;
            this.approval = approval;
        }
    }

    static final class Decision {
        final Outcome outcome;
        final Action action;
        final Phase nextPhase;
        final Screen nextScreen;
        final String targetLocalId;
        final String videoId;
        final String reason;

        private Decision(
                Outcome outcome,
                Action action,
                Phase nextPhase,
                Screen nextScreen,
                String targetLocalId,
                String videoId,
                String reason
        ) {
            this.outcome = outcome;
            this.action = action;
            this.nextPhase = nextPhase;
            this.nextScreen = nextScreen;
            this.targetLocalId = safe(targetLocalId);
            this.videoId = safe(videoId);
            this.reason = safe(reason);
        }
    }

    static String resolveExpectedPackage(
            String variantOverride,
            String preferredVariant,
            Set<String> installedPackages
    ) {
        Set<String> installed = immutableSet(installedPackages);
        String explicit = resolveAlias(variantOverride);
        if (!safe(variantOverride).isEmpty()) {
            return installed.contains(explicit) ? explicit : "";
        }

        String preferred = resolveAlias(preferredVariant);
        if (!preferred.isEmpty() && installed.contains(preferred)) {
            return preferred;
        }
        // Advanced/ReVanced is the product preference when both variants exist.
        if (installed.contains(REVANCED_PACKAGE)) {
            return REVANCED_PACKAGE;
        }
        return installed.contains(OFFICIAL_PACKAGE) ? OFFICIAL_PACKAGE : "";
    }

    static UiProfile profileForPackage(String packageName) {
        return PROFILES.get(safe(packageName));
    }

    static Operation begin(
            String operationId,
            Kind kind,
            String expectedPackage,
            String argumentDigest,
            String title,
            String channel,
            String playlist,
            long nowMs,
            long expiresAtMs,
            Observation initial
    ) {
        if (safe(operationId).isEmpty()
                || kind == null
                || profileForPackage(expectedPackage) == null
                || safe(argumentDigest).isEmpty()
                || initial == null
                || expiresAtMs <= nowMs
                || expiresAtMs - nowMs > MAX_OPERATION_LIFETIME_MS) {
            return null;
        }

        Phase phase;
        Screen screen;
        if (kind == Kind.OPEN_SEARCH_RESULT) {
            phase = Phase.SEARCH_RESULT;
            screen = Screen.SEARCH_RESULTS;
        } else if (kind == Kind.CAPTURE_BOOKMARK_ID) {
            phase = Phase.BOOKMARK_OPEN_SHARE;
            screen = Screen.WATCH;
        } else {
            phase = Phase.PLAYLIST_OPEN_MENU;
            screen = Screen.WATCH;
        }
        UiProfile profile = profileForPackage(expectedPackage);
        if (initial.screen != screen || initial.fingerprint.isEmpty()
                || !expectedPackage.equals(initial.packageName)
                || profile == null || !profile.version.equals(initial.profileVersion)
                || !initial.evidence.containsAll(profile.requiredEvidence(screen))) {
            return null;
        }
        if (isPlaylistMutation(kind) && initial.mediaIdentity.isEmpty()) {
            return null;
        }
        return new Operation(
                operationId,
                kind,
                expectedPackage,
                argumentDigest,
                title,
                channel,
                playlist,
                initial.mediaIdentity,
                expiresAtMs,
                phase,
                screen,
                initial.fingerprint,
                0,
                null
        );
    }

    static Operation withApproval(Operation operation, Approval approval, long nowMs) {
        if (operation == null || !isPlaylistMutation(operation.kind) || !approvalMatches(operation, approval, nowMs)) {
            return operation;
        }
        return copy(operation, operation.phase, operation.expectedScreen,
                operation.expectedFingerprint, operation.traversals, approval);
    }

    static Decision evaluate(Operation operation, Observation observation, long nowMs) {
        Decision invalid = validate(operation, observation, nowMs);
        if (invalid != null) {
            return invalid;
        }

        switch (operation.phase) {
            case SEARCH_RESULT:
                return evaluateSearch(operation, observation);
            case BOOKMARK_OPEN_SHARE:
                return ready(Action.OPEN_SHARE, Phase.BOOKMARK_COPY_LINK, Screen.SHARE, "", "");
            case BOOKMARK_COPY_LINK:
                return evaluateCopiedLink(observation);
            case BOOKMARK_RETURN:
                return complete("bookmark video id captured");
            case PLAYLIST_OPEN_MENU:
                if (!approvalMatches(operation, operation.approval, nowMs)) {
                    return terminal(Outcome.NEEDS_APPROVAL, "playlist mutation requires current local approval");
                }
                return ready(Action.OPEN_PLAYLIST_MENU, Phase.PLAYLIST_PICKER, Screen.PLAYLIST_PICKER, "", "");
            case PLAYLIST_PICKER:
                return evaluatePlaylist(operation, observation, nowMs);
            case PLAYLIST_VERIFY:
                return verifyPlaylist(operation, observation, nowMs);
            case DONE:
                return complete("operation already complete");
            default:
                return terminal(Outcome.UNSUPPORTED, "unknown fixed operation phase");
        }
    }

    /**
     * Binds the exact next window fingerprint after the adapter executes the
     * returned semantic action. A mismatched next screen is rejected here and
     * will also fail closed during the next evaluate call.
     */
    static Operation advance(Operation operation, Decision decision, Observation nextObservation) {
        if (operation == null
                || decision == null
                || decision.outcome != Outcome.READY
                || decision.nextPhase == null
                || decision.nextScreen == null
                || nextObservation == null
                || !operation.expectedPackage.equals(nextObservation.packageName)
                || decision.nextScreen != nextObservation.screen
                || nextObservation.fingerprint.isEmpty()) {
            return null;
        }
        int traversals = operation.traversals;
        if (decision.action == Action.SCROLL_RESULTS || decision.action == Action.SCROLL_PLAYLISTS) {
            traversals += 1;
        }
        return copy(operation, decision.nextPhase, decision.nextScreen,
                nextObservation.fingerprint, traversals, operation.approval);
    }

    static String extractVideoId(String copiedLink) {
        String value = safe(copiedLink);
        if (VIDEO_ID.matcher(value).matches()) {
            return value;
        }
        try {
            URI uri = new URI(value);
            String host = safe(uri.getHost()).toLowerCase(Locale.US);
            if (host.equals("youtu.be")) {
                String path = safe(uri.getPath());
                String candidate = path.startsWith("/") ? path.substring(1) : path;
                int slash = candidate.indexOf('/');
                if (slash >= 0) {
                    candidate = candidate.substring(0, slash);
                }
                return VIDEO_ID.matcher(candidate).matches() ? candidate : "";
            }
            if (!host.equals("youtube.com") && !host.endsWith(".youtube.com")) {
                return "";
            }
            String path = safe(uri.getPath());
            if (path.equals("/watch")) {
                String query = safe(uri.getRawQuery());
                for (String part : query.split("&")) {
                    int equals = part.indexOf('=');
                    if (equals > 0 && part.substring(0, equals).equals("v")) {
                        String candidate = part.substring(equals + 1);
                        return VIDEO_ID.matcher(candidate).matches() ? candidate : "";
                    }
                }
            }
            Matcher pathId = Pattern.compile("^/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})(?:/.*)?$").matcher(path);
            return pathId.matches() ? pathId.group(1) : "";
        } catch (URISyntaxException ignored) {
            return "";
        }
    }

    static String extractCanonicalWatchVideoId(String copiedLink) {
        try {
            URI uri = new URI(safe(copiedLink));
            String host = safe(uri.getHost()).toLowerCase(Locale.US);
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || !(host.equals("youtube.com") || host.equals("www.youtube.com"))
                    || !"/watch".equals(uri.getPath())) {
                return "";
            }
            String found = "";
            for (String part : safe(uri.getRawQuery()).split("&")) {
                int equals = part.indexOf('=');
                if (equals > 0 && "v".equals(part.substring(0, equals))) {
                    String candidate = part.substring(equals + 1);
                    if (!found.isEmpty() || !VIDEO_ID.matcher(candidate).matches()) {
                        return "";
                    }
                    found = candidate;
                }
            }
            return found;
        } catch (URISyntaxException ignored) {
            return "";
        }
    }

    private static Decision validate(Operation operation, Observation observation, long nowMs) {
        if (operation == null || observation == null) {
            return terminal(Outcome.UNSUPPORTED, "missing operation or observation");
        }
        if (nowMs >= operation.expiresAtMs) {
            return terminal(Outcome.EXPIRED, "operation expired");
        }
        UiProfile profile = profileForPackage(operation.expectedPackage);
        if (profile == null || !operation.expectedPackage.equals(observation.packageName)) {
            return terminal(Outcome.STALE_STATE, "active package changed or is unsupported");
        }
        if (!profile.version.equals(observation.profileVersion)) {
            return terminal(Outcome.UI_DRIFT, "unsupported package UI profile version");
        }
        if (operation.expectedScreen != observation.screen
                || !operation.expectedFingerprint.equals(observation.fingerprint)) {
            return terminal(Outcome.STALE_STATE, "expected window state or fingerprint changed");
        }
        if (observation.observedNodeCount < 0 || observation.observedNodeCount > MAX_OBSERVED_NODES) {
            return terminal(Outcome.LIMIT_REACHED, "bounded UI traversal exceeded");
        }
        if (!observation.evidence.containsAll(profile.requiredEvidence(observation.screen))) {
            return terminal(Outcome.UI_DRIFT, "required versioned UI evidence is missing");
        }
        if (observation.screen == Screen.WATCH
                && !operation.expectedMediaIdentity.isEmpty()
                && !operation.expectedMediaIdentity.equals(observation.mediaIdentity)) {
            return terminal(Outcome.STALE_STATE, "current video identity changed");
        }
        return null;
    }

    private static Decision evaluateSearch(Operation operation, Observation observation) {
        List<Candidate> exact = new ArrayList<>();
        List<Candidate> high = new ArrayList<>();
        String wantedTitle = normalize(operation.title);
        String wantedChannel = normalize(operation.channel);
        if (wantedTitle.isEmpty()) {
            return terminal(Outcome.UNSUPPORTED, "title evidence is required");
        }

        for (Candidate candidate : observation.candidates) {
            if (!candidate.actionable || candidate.localId.isEmpty() || candidate.fingerprint.isEmpty()) {
                continue;
            }
            String candidateTitle = normalize(candidate.title);
            String candidateChannel = normalize(candidate.channel);
            if (!wantedChannel.isEmpty() && !candidateChannel.equals(wantedChannel)) {
                continue;
            }
            if (candidateTitle.equals(wantedTitle)) {
                exact.add(candidate);
            } else if (!wantedChannel.isEmpty()
                    && tokenSimilarity(wantedTitle, candidateTitle) >= 0.85d) {
                high.add(candidate);
            }
        }

        List<Candidate> matches = exact.isEmpty() ? high : exact;
        if (matches.size() > 1) {
            return terminal(Outcome.AMBIGUOUS, wantedChannel.isEmpty()
                    ? "more than one visible result matches the exact title"
                    : "more than one visible result matches title and channel");
        }
        if (matches.size() == 1) {
            return ready(Action.TAP_MATCHED_RESULT, Phase.DONE, Screen.WATCH,
                    matches.get(0).localId, "");
        }
        if (operation.traversals >= MAX_TRAVERSALS) {
            return terminal(Outcome.LIMIT_REACHED, "result not found within scroll limit");
        }
        return ready(Action.SCROLL_RESULTS, Phase.SEARCH_RESULT, Screen.SEARCH_RESULTS, "", "");
    }

    private static Decision evaluateCopiedLink(Observation observation) {
        String videoId = extractVideoId(observation.copiedLink);
        if (!observation.copiedLink.isEmpty() && videoId.isEmpty()) {
            return terminal(Outcome.UNSUPPORTED, "Share/Copy link did not expose a stable 11-character video id");
        }
        if (videoId.isEmpty()) {
            return ready(Action.COPY_LINK, Phase.BOOKMARK_COPY_LINK, Screen.SHARE, "", "");
        }
        return ready(Action.DISMISS_SHARE, Phase.BOOKMARK_RETURN, Screen.WATCH, "", videoId);
    }

    private static Decision evaluatePlaylist(Operation operation, Observation observation, long nowMs) {
        if (!approvalMatches(operation, operation.approval, nowMs)) {
            return terminal(Outcome.NEEDS_APPROVAL, "playlist approval expired or no longer matches");
        }
        String wanted = normalize(operation.playlist);
        if (wanted.isEmpty()) {
            return terminal(Outcome.UNSUPPORTED, "playlist name is required");
        }
        List<Candidate> matches = new ArrayList<>();
        for (Candidate candidate : observation.candidates) {
            if (candidate.actionable
                    && candidate.checkable
                    && !candidate.localId.isEmpty()
                    && !candidate.fingerprint.isEmpty()
                    && normalize(candidate.title).equals(wanted)) {
                matches.add(candidate);
            }
        }
        if (matches.size() > 1) {
            return terminal(Outcome.AMBIGUOUS, "playlist name is not unique in the visible picker");
        }
        if (matches.size() == 1) {
            boolean wantedChecked = operation.kind == Kind.ADD_TO_PLAYLIST;
            if (operation.kind == Kind.REMOVE_FROM_PLAYLIST && !matches.get(0).checked) {
                return terminal(Outcome.STALE_STATE,
                        "remove requires observed checked membership before mutation");
            }
            if (matches.get(0).checked == wantedChecked) {
                return complete("playlist already has requested membership state");
            }
            return ready(Action.SELECT_PLAYLIST, Phase.PLAYLIST_VERIFY, Screen.PLAYLIST_PICKER,
                    matches.get(0).localId, "");
        }
        if (operation.traversals >= MAX_TRAVERSALS) {
            return terminal(Outcome.LIMIT_REACHED, "playlist not found within scroll limit");
        }
        return ready(Action.SCROLL_PLAYLISTS, Phase.PLAYLIST_PICKER, Screen.PLAYLIST_PICKER, "", "");
    }

    private static Decision verifyPlaylist(Operation operation, Observation observation, long nowMs) {
        if (!approvalMatches(operation, operation.approval, nowMs)) {
            return terminal(Outcome.NEEDS_APPROVAL, "playlist approval expired or no longer matches");
        }
        String wanted = normalize(operation.playlist);
        List<Candidate> matches = new ArrayList<>();
        for (Candidate candidate : observation.candidates) {
            if (candidate.actionable && candidate.checkable && !candidate.localId.isEmpty()
                    && !candidate.fingerprint.isEmpty()
                    && normalize(candidate.title).equals(wanted)) {
                matches.add(candidate);
            }
        }
        if (matches.size() != 1) {
            return terminal(matches.size() > 1 ? Outcome.AMBIGUOUS : Outcome.UI_DRIFT,
                    "exact playlist membership effect was not observable");
        }
        boolean wantedChecked = operation.kind == Kind.ADD_TO_PLAYLIST;
        return matches.get(0).checked == wantedChecked
                ? complete("exact playlist membership state observed")
                : terminal(Outcome.UI_DRIFT, "exact playlist membership state did not change");
    }

    private static boolean approvalMatches(Operation operation, Approval approval, long nowMs) {
        return approval != null
                && approval.approved
                && nowMs < approval.expiresAtMs
                && approval.expiresAtMs <= operation.expiresAtMs
                && operation.operationId.equals(approval.operationId)
                && operation.argumentDigest.equals(approval.argumentDigest)
                && operation.expectedPackage.equals(approval.packageName);
    }

    private static boolean isPlaylistMutation(Kind kind) {
        return kind == Kind.ADD_TO_PLAYLIST || kind == Kind.REMOVE_FROM_PLAYLIST;
    }

    private static Operation copy(
            Operation source,
            Phase phase,
            Screen screen,
            String fingerprint,
            int traversals,
            Approval approval
    ) {
        return new Operation(
                source.operationId,
                source.kind,
                source.expectedPackage,
                source.argumentDigest,
                source.title,
                source.channel,
                source.playlist,
                source.expectedMediaIdentity,
                source.expiresAtMs,
                phase,
                screen,
                fingerprint,
                traversals,
                approval
        );
    }

    private static Decision ready(
            Action action,
            Phase nextPhase,
            Screen nextScreen,
            String targetLocalId,
            String videoId
    ) {
        return new Decision(Outcome.READY, action, nextPhase, nextScreen,
                targetLocalId, videoId, "");
    }

    private static Decision terminal(Outcome outcome, String reason) {
        return new Decision(outcome, Action.NONE, null, null, "", "", reason);
    }

    private static Decision complete(String reason) {
        return new Decision(Outcome.COMPLETE, Action.NONE, Phase.DONE, null, "", "", reason);
    }

    private static String resolveAlias(String value) {
        String normalized = normalize(value);
        String resolved = PACKAGE_ALIASES.get(normalized);
        return resolved == null ? "" : resolved;
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
        Set<String> values = new HashSet<>();
        for (String token : normalize(value).split(" ")) {
            if (!token.isEmpty()) {
                values.add(token);
            }
        }
        return values;
    }

    private static String normalize(String value) {
        return safe(value)
                .toLowerCase(Locale.US)
                .replaceAll("[^a-z0-9]+", " ")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static Set<String> immutableSet(Set<String> values) {
        return values == null
                ? Collections.emptySet()
                : Collections.unmodifiableSet(new HashSet<>(values));
    }

    private static Map<String, String> createAliases() {
        Map<String, String> aliases = new HashMap<>();
        aliases.put("youtube", OFFICIAL_PACKAGE);
        aliases.put("official", OFFICIAL_PACKAGE);
        aliases.put(normalize(OFFICIAL_PACKAGE), OFFICIAL_PACKAGE);
        aliases.put("revanced", REVANCED_PACKAGE);
        aliases.put("advanced", REVANCED_PACKAGE);
        aliases.put("youtube revanced", REVANCED_PACKAGE);
        aliases.put(normalize(REVANCED_PACKAGE), REVANCED_PACKAGE);
        return Collections.unmodifiableMap(aliases);
    }

    private static Map<String, UiProfile> createProfiles() {
        Map<String, UiProfile> profiles = new HashMap<>();
        profiles.put(OFFICIAL_PACKAGE, profile(
                OFFICIAL_PACKAGE,
                "official",
                "youtube-official-ui-v1"
        ));
        profiles.put(REVANCED_PACKAGE, profile(
                REVANCED_PACKAGE,
                "advanced-revanced",
                "youtube-revanced-ui-v1"
        ));
        return Collections.unmodifiableMap(profiles);
    }

    private static UiProfile profile(String packageName, String variant, String version) {
        Map<Screen, Set<String>> evidence = new HashMap<>();
        evidence.put(Screen.SEARCH_RESULTS, setOf("search_results", "video_title", "channel_name"));
        evidence.put(Screen.WATCH, setOf("watch_root", "video_title", "share", "playlist_action"));
        evidence.put(Screen.SHARE, setOf("share_sheet", "copy_link"));
        evidence.put(Screen.PLAYLIST_PICKER, setOf("playlist_picker", "playlist_name"));
        return new UiProfile(packageName, variant, version, Collections.unmodifiableMap(evidence));
    }

    private static Set<String> setOf(String... values) {
        Set<String> result = new HashSet<>();
        Collections.addAll(result, values);
        return Collections.unmodifiableSet(result);
    }
}

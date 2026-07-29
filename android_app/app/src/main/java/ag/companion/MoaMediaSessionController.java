package ag.companion;

import android.content.Context;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Locale;

/** Device-local, package-bound authority for YouTube-like MediaSessions. */
final class MoaMediaSessionController {
    static final long MAX_MEDIA_TIME_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final int MAX_PACKAGE_CHARS = 255;
    private static final int MAX_MEDIA_ID_CHARS = 512;
    private static final int MAX_MEDIA_URI_CHARS = 1024;
    private static final int MAX_TITLE_CHARS = 300;
    private static final int MAX_ARTIST_CHARS = 200;
    private static final int MAX_QUERY_CHARS = 300;
    private static final long SEEK_CONFIRM_TIMEOUT_MS = 600L;
    private static final long SEEK_CONFIRM_POLL_MS = 50L;
    static final long SEEK_CONFIRM_TOLERANCE_MS = 2_000L;

    private final Context context;

    MoaMediaSessionController(Context context) {
        this.context = context.getApplicationContext();
    }

    boolean hasNotificationAccess() {
        return MoaMediaNotificationListenerService.isAccessEnabled(context);
    }

    Intent notificationAccessSettingsIntent() {
        return MoaMediaNotificationListenerService.accessSettingsIntent();
    }

    Snapshot currentSnapshot(String preferredPackage) {
        if (!hasNotificationAccess()) {
            return null;
        }
        MediaController controller = selectController(
                MoaMediaNotificationListenerService.activeControllers(context),
                preferredPackage
        );
        return controller == null ? null : snapshot(controller, SystemClock.elapsedRealtime());
    }

    ControlResult play(String expectedPackage, String expectedFingerprint) {
        return execute(expectedPackage, expectedFingerprint, PlaybackState.ACTION_PLAY,
                controls -> controls.play());
    }

    ControlResult pause(String expectedPackage, String expectedFingerprint) {
        return execute(expectedPackage, expectedFingerprint, PlaybackState.ACTION_PAUSE,
                controls -> controls.pause());
    }

    ControlResult stop(String expectedPackage, String expectedFingerprint) {
        return execute(expectedPackage, expectedFingerprint, PlaybackState.ACTION_STOP,
                controls -> controls.stop());
    }

    ControlResult toggle(String expectedPackage, String expectedFingerprint) {
        BoundSession bound = resolve(expectedPackage, expectedFingerprint);
        if (bound.result != null) {
            return bound.result;
        }
        if (!isActionAdvertised(bound.snapshot.actions, PlaybackState.ACTION_PLAY_PAUSE)) {
            return ControlResult.unsupported(bound.snapshot, "play_pause_not_advertised");
        }
        try {
            if (isPlayingState(bound.snapshot.playbackState)) {
                bound.controller.getTransportControls().pause();
            } else {
                bound.controller.getTransportControls().play();
            }
            return ControlResult.executed(bound.snapshot);
        } catch (RuntimeException ignored) {
            return ControlResult.failed(bound.snapshot, "transport_failed");
        }
    }

    ControlResult next(String expectedPackage, String expectedFingerprint) {
        return execute(expectedPackage, expectedFingerprint, PlaybackState.ACTION_SKIP_TO_NEXT,
                controls -> controls.skipToNext());
    }

    ControlResult previous(String expectedPackage, String expectedFingerprint) {
        return execute(expectedPackage, expectedFingerprint, PlaybackState.ACTION_SKIP_TO_PREVIOUS,
                controls -> controls.skipToPrevious());
    }

    ControlResult seek(String expectedPackage, String expectedFingerprint, long requestedPositionMs) {
        BoundSession bound = resolve(expectedPackage, expectedFingerprint);
        if (bound.result != null) {
            return bound.result;
        }
        if (!isActionAdvertised(bound.snapshot.actions, PlaybackState.ACTION_SEEK_TO)) {
            return ControlResult.unsupported(bound.snapshot, "seek_not_advertised");
        }
        long target = clampPosition(requestedPositionMs, bound.snapshot.durationMs);
        try {
            bound.controller.getTransportControls().seekTo(target);
            return confirmSeek(expectedPackage, expectedFingerprint, target);
        } catch (RuntimeException ignored) {
            return ControlResult.failed(bound.snapshot, "transport_failed");
        }
    }

    ControlResult seekBy(String expectedPackage, String expectedFingerprint, long offsetMs) {
        BoundSession bound = resolve(expectedPackage, expectedFingerprint);
        if (bound.result != null) return bound.result;
        if (!isActionAdvertised(bound.snapshot.actions, PlaybackState.ACTION_SEEK_TO)) {
            return ControlResult.unsupported(bound.snapshot, "seek_not_advertised");
        }
        long target = relativePosition(bound.snapshot.positionMs, offsetMs, bound.snapshot.durationMs);
        try {
            bound.controller.getTransportControls().seekTo(target);
            return confirmSeek(expectedPackage, expectedFingerprint, target);
        } catch (RuntimeException ignored) {
            return ControlResult.failed(bound.snapshot, "transport_failed");
        }
    }

    private ControlResult confirmSeek(String expectedPackage, String expectedFingerprint, long target) {
        long deadline = SystemClock.elapsedRealtime() + SEEK_CONFIRM_TIMEOUT_MS;
        ControlResult lastError = null;
        do {
            SystemClock.sleep(SEEK_CONFIRM_POLL_MS);
            BoundSession fresh = resolve(expectedPackage, expectedFingerprint);
            if (fresh.result != null) lastError = fresh.result;
            else if (positionWithinTolerance(target, fresh.snapshot.positionMs,
                    SEEK_CONFIRM_TOLERANCE_MS)) return ControlResult.executed(fresh.snapshot, target);
        } while (SystemClock.elapsedRealtime() < deadline);
        return lastError != null ? lastError
                : ControlResult.failed(null, "seek_position_unconfirmed");
    }

    ControlResult playFromSearch(
            String expectedPackage,
            String expectedFingerprint,
            String query
    ) {
        String boundedQuery = bounded(query, MAX_QUERY_CHARS);
        if (boundedQuery.isEmpty()) {
            return ControlResult.invalid("search_query_required");
        }
        return execute(expectedPackage, expectedFingerprint, PlaybackState.ACTION_PLAY_FROM_SEARCH,
                controls -> controls.playFromSearch(boundedQuery, Bundle.EMPTY));
    }

    ControlResult playFromUri(
            String expectedPackage,
            String expectedFingerprint,
            String mediaUri
    ) {
        String validUri = validatedYouTubeHttpsUri(mediaUri);
        if (validUri.isEmpty()) {
            return ControlResult.invalid("validated_youtube_https_uri_required");
        }
        return execute(expectedPackage, expectedFingerprint, PlaybackState.ACTION_PLAY_FROM_URI,
                controls -> controls.playFromUri(Uri.parse(validUri), Bundle.EMPTY));
    }

    private ControlResult execute(
            String expectedPackage,
            String expectedFingerprint,
            long requiredAction,
            TransportCommand command
    ) {
        BoundSession bound = resolve(expectedPackage, expectedFingerprint);
        if (bound.result != null) {
            return bound.result;
        }
        if (!isActionAdvertised(bound.snapshot.actions, requiredAction)) {
            return ControlResult.unsupported(bound.snapshot, "action_not_advertised");
        }
        try {
            command.run(bound.controller.getTransportControls());
            return ControlResult.executed(bound.snapshot);
        } catch (RuntimeException ignored) {
            return ControlResult.failed(bound.snapshot, "transport_failed");
        }
    }

    private BoundSession resolve(String expectedPackage, String expectedFingerprint) {
        String expected = bounded(expectedPackage, MAX_PACKAGE_CHARS);
        String fingerprint = safe(expectedFingerprint);
        if (expected.isEmpty() || fingerprint.isEmpty() || !isYouTubeLikePackage(expected)) {
            return BoundSession.error(ControlResult.invalid("package_and_media_fingerprint_required"));
        }
        if (!hasNotificationAccess()) {
            return BoundSession.error(ControlResult.needsPermission());
        }
        MediaController controller = selectController(
                MoaMediaNotificationListenerService.activeControllers(context), expected);
        if (controller == null || !packageMatches(expected, controller.getPackageName())) {
            return BoundSession.error(ControlResult.stale("media_package_changed"));
        }
        Snapshot snapshot = snapshot(controller, SystemClock.elapsedRealtime());
        if (!fingerprint.equals(snapshot.mediaFingerprint)) {
            return BoundSession.error(ControlResult.stale("media_fingerprint_changed"));
        }
        return BoundSession.resolved(controller, snapshot);
    }

    private static MediaController selectController(
            List<MediaController> controllers,
            String preferredPackage
    ) {
        if (controllers == null || controllers.isEmpty()) {
            return null;
        }
        String preferred = safe(preferredPackage);
        MediaController selected = null;
        int selectedScore = Integer.MIN_VALUE;
        for (MediaController candidate : controllers) {
            if (candidate == null || !isYouTubeLikePackage(candidate.getPackageName())) {
                continue;
            }
            int score = playbackPriority(candidate.getPlaybackState());
            if (!preferred.isEmpty() && packageMatches(preferred, candidate.getPackageName())) {
                score += 1_000;
            }
            if (selected == null || score > selectedScore) {
                selected = candidate;
                selectedScore = score;
            }
        }
        return selected;
    }

    private static Snapshot snapshot(MediaController controller, long nowElapsedMs) {
        MediaMetadata metadata = controller.getMetadata();
        PlaybackState state = controller.getPlaybackState();
        String mediaId = metadata == null ? "" : bounded(
                metadata.getString(MediaMetadata.METADATA_KEY_MEDIA_ID), MAX_MEDIA_ID_CHARS);
        String mediaUri = metadata == null ? "" : bounded(
                metadata.getString(MediaMetadata.METADATA_KEY_MEDIA_URI), MAX_MEDIA_URI_CHARS);
        String title = metadata == null ? "" : bounded(
                metadata.getString(MediaMetadata.METADATA_KEY_TITLE), MAX_TITLE_CHARS);
        String artist = metadata == null ? "" : bounded(
                metadata.getString(MediaMetadata.METADATA_KEY_ARTIST), MAX_ARTIST_CHARS);
        long duration = metadata == null ? 0L : boundedDuration(
                metadata.getLong(MediaMetadata.METADATA_KEY_DURATION));
        int playbackState = state == null ? PlaybackState.STATE_NONE : state.getState();
        long actions = state == null ? 0L : state.getActions();
        long position = state == null ? 0L : extrapolatePosition(
                state.getPosition(),
                state.getLastPositionUpdateTime(),
                nowElapsedMs,
                state.getPlaybackSpeed(),
                isPlayingState(playbackState),
                duration
        );
        String identityStrength = identityStrength(mediaId, mediaUri, title);
        String packageName = bounded(controller.getPackageName(), MAX_PACKAGE_CHARS);
        String fingerprint = mediaFingerprint(
                packageName, mediaId, mediaUri, title, artist, duration);
        return new Snapshot(
                packageName,
                mediaId,
                mediaUri,
                title,
                artist,
                duration,
                position,
                playbackState,
                actions,
                identityStrength,
                fingerprint
        );
    }

    static boolean isYouTubeLikePackage(String packageName) {
        String value = safe(packageName).toLowerCase(Locale.US);
        return !value.isEmpty() && value.length() <= MAX_PACKAGE_CHARS && value.contains("youtube");
    }

    static boolean packageMatches(String expected, String actual) {
        return !safe(expected).isEmpty() && safe(expected).equalsIgnoreCase(safe(actual));
    }

    static boolean isActionAdvertised(long advertisedActions, long requiredAction) {
        return requiredAction != 0L && (advertisedActions & requiredAction) == requiredAction;
    }

    static String identityStrength(String mediaId, String mediaUri, String title) {
        if (!safe(mediaId).isEmpty() || !safe(mediaUri).isEmpty()) {
            return "strong";
        }
        return safe(title).isEmpty() ? "unavailable" : "weak";
    }

    static long extrapolatePosition(
            long positionMs,
            long updatedAtElapsedMs,
            long nowElapsedMs,
            float speed,
            boolean advancing,
            long durationMs
    ) {
        double value = Math.max(0L, positionMs);
        if (advancing && speed > 0.0f && nowElapsedMs > updatedAtElapsedMs && updatedAtElapsedMs >= 0L) {
            value += (nowElapsedMs - updatedAtElapsedMs) * (double) speed;
        }
        long rounded = value >= MAX_MEDIA_TIME_MS ? MAX_MEDIA_TIME_MS : Math.round(value);
        return clampPosition(rounded, durationMs);
    }

    static long clampPosition(long positionMs, long durationMs) {
        long upperBound = boundedDuration(durationMs);
        if (upperBound <= 0L) {
            upperBound = MAX_MEDIA_TIME_MS;
        }
        return Math.max(0L, Math.min(positionMs, upperBound));
    }

    static long relativePosition(long currentMs, long offsetMs, long durationMs) {
        long current = clampPosition(currentMs, durationMs);
        if (offsetMs > 0L && current > MAX_MEDIA_TIME_MS - offsetMs) {
            return clampPosition(MAX_MEDIA_TIME_MS, durationMs);
        }
        if (offsetMs < 0L && (offsetMs == Long.MIN_VALUE || current < -offsetMs)) return 0L;
        return clampPosition(current + offsetMs, durationMs);
    }

    static boolean positionWithinTolerance(long targetMs, long observedMs, long toleranceMs) {
        if (targetMs < 0L || observedMs < 0L || toleranceMs < 0L) return false;
        long difference = targetMs >= observedMs ? targetMs - observedMs : observedMs - targetMs;
        return difference <= toleranceMs;
    }

    static String mediaFingerprint(
            String packageName,
            String mediaId,
            String mediaUri,
            String title,
            String artist,
            long durationMs
    ) {
        String stableIdentity = !safe(mediaId).isEmpty()
                ? "id:" + bounded(mediaId, MAX_MEDIA_ID_CHARS)
                : (!safe(mediaUri).isEmpty()
                ? "uri:" + bounded(mediaUri, MAX_MEDIA_URI_CHARS)
                : "weak:" + normalize(title) + "\n" + normalize(artist));
        String source = safe(packageName).toLowerCase(Locale.US)
                + "\n" + stableIdentity + "\n" + boundedDuration(durationMs);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(source.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte item : digest) {
                result.append(String.format(Locale.US, "%02x", item & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    static String validatedYouTubeHttpsUri(String input) {
        String candidate = bounded(input, MAX_MEDIA_URI_CHARS);
        if (candidate.isEmpty()) {
            return "";
        }
        try {
            URI uri = URI.create(candidate);
            String host = safe(uri.getHost()).toLowerCase(Locale.US);
            boolean youtubeHost = host.equals("youtube.com")
                    || host.endsWith(".youtube.com")
                    || host.equals("youtu.be");
            return "https".equalsIgnoreCase(uri.getScheme()) && youtubeHost ? candidate : "";
        } catch (IllegalArgumentException ignored) {
            return "";
        }
    }

    private static int playbackPriority(PlaybackState state) {
        if (state == null) {
            return 0;
        }
        switch (state.getState()) {
            case PlaybackState.STATE_PLAYING:
                return 100;
            case PlaybackState.STATE_BUFFERING:
            case PlaybackState.STATE_CONNECTING:
                return 80;
            case PlaybackState.STATE_PAUSED:
                return 60;
            default:
                return 20;
        }
    }

    private static boolean isPlayingState(int state) {
        return state == PlaybackState.STATE_PLAYING
                || state == PlaybackState.STATE_BUFFERING
                || state == PlaybackState.STATE_CONNECTING;
    }

    private static long boundedDuration(long durationMs) {
        return Math.max(0L, Math.min(durationMs, MAX_MEDIA_TIME_MS));
    }

    private static String normalize(String value) {
        return safe(value).trim().toLowerCase(Locale.US).replaceAll("\\s+", " ");
    }

    private static String bounded(String value, int limit) {
        String trimmed = safe(value).trim();
        return trimmed.length() <= limit ? trimmed : trimmed.substring(0, limit);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private interface TransportCommand {
        void run(MediaController.TransportControls controls);
    }

    static final class Snapshot {
        final String packageName;
        final String mediaId;
        final String mediaUri;
        final String title;
        final String artist;
        final long durationMs;
        final long positionMs;
        final int playbackState;
        final long actions;
        final String identityStrength;
        final String mediaFingerprint;

        Snapshot(
                String packageName,
                String mediaId,
                String mediaUri,
                String title,
                String artist,
                long durationMs,
                long positionMs,
                int playbackState,
                long actions,
                String identityStrength,
                String mediaFingerprint
        ) {
            this.packageName = packageName;
            this.mediaId = mediaId;
            this.mediaUri = mediaUri;
            this.title = title;
            this.artist = artist;
            this.durationMs = durationMs;
            this.positionMs = positionMs;
            this.playbackState = playbackState;
            this.actions = actions;
            this.identityStrength = identityStrength;
            this.mediaFingerprint = mediaFingerprint;
        }

        boolean hasStrongIdentity() {
            return "strong".equals(identityStrength);
        }

        JSONObject toJson() {
            JSONObject value = new JSONObject();
            try {
                value.put("schema_version", 1);
                value.put("package_name", packageName);
                value.put("media_id", mediaId);
                value.put("media_uri", mediaUri);
                value.put("title", title);
                value.put("artist", artist);
                value.put("duration_ms", durationMs);
                value.put("position_ms", positionMs);
                value.put("playback_state", playbackState);
                value.put("advertised_actions", actions);
                value.put("identity_strength", identityStrength);
                value.put("media_fingerprint", mediaFingerprint);
                value.put("notification_contents_included", false);
            } catch (JSONException ignored) {
            }
            return value;
        }
    }

    static final class ControlResult {
        enum Status {
            EXECUTED,
            NEEDS_PERMISSION,
            NO_SESSION,
            STALE_TARGET,
            UNSUPPORTED,
            INVALID_INPUT,
            FAILED
        }

        final Status status;
        final Snapshot snapshot;
        final String reason;
        final Long appliedPositionMs;

        private ControlResult(Status status, Snapshot snapshot, String reason, Long appliedPositionMs) {
            this.status = status;
            this.snapshot = snapshot;
            this.reason = reason;
            this.appliedPositionMs = appliedPositionMs;
        }

        boolean executed() {
            return status == Status.EXECUTED;
        }

        static ControlResult executed(Snapshot snapshot) {
            return new ControlResult(Status.EXECUTED, snapshot, "", null);
        }

        static ControlResult executed(Snapshot snapshot, long appliedPositionMs) {
            return new ControlResult(Status.EXECUTED, snapshot, "", appliedPositionMs);
        }

        static ControlResult needsPermission() {
            return new ControlResult(Status.NEEDS_PERMISSION, null, "notification_access_required", null);
        }

        static ControlResult noSession() {
            return new ControlResult(Status.NO_SESSION, null, "youtube_media_session_unavailable", null);
        }

        static ControlResult stale(String reason) {
            return new ControlResult(Status.STALE_TARGET, null, reason, null);
        }

        static ControlResult unsupported(Snapshot snapshot, String reason) {
            return new ControlResult(Status.UNSUPPORTED, snapshot, reason, null);
        }

        static ControlResult invalid(String reason) {
            return new ControlResult(Status.INVALID_INPUT, null, reason, null);
        }

        static ControlResult failed(Snapshot snapshot, String reason) {
            return new ControlResult(Status.FAILED, snapshot, reason, null);
        }
    }

    private static final class BoundSession {
        final MediaController controller;
        final Snapshot snapshot;
        final ControlResult result;

        private BoundSession(MediaController controller, Snapshot snapshot, ControlResult result) {
            this.controller = controller;
            this.snapshot = snapshot;
            this.result = result;
        }

        static BoundSession resolved(MediaController controller, Snapshot snapshot) {
            return new BoundSession(controller, snapshot, null);
        }

        static BoundSession error(ControlResult result) {
            return new BoundSession(null, null, result);
        }
    }
}

package ag.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** App-private persistence and deterministic spoken-label resolution for YouTube media spots. */
public final class MoaMediaSpotStore {
    static final int SCHEMA_VERSION = 1;
    static final double TOKEN_MATCH_THRESHOLD = 0.35d;

    private static final String PREFS_NAME = "moa_media_spots";
    private static final String PREFS_KEY = "records_json";
    private static final Pattern YOUTUBE_VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final double SCORE_EPSILON = 0.000001d;
    private static final Set<String> QUERY_FILLER = Set.of(
            "a", "an", "and", "at", "back", "go", "in", "it", "last", "me", "my",
            "of", "on", "open", "play", "please", "remember", "seek", "spot", "the",
            "this", "to", "video", "youtube"
    );

    private final SharedPreferences preferences;

    public MoaMediaSpotStore(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context_required");
        }
        preferences = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public synchronized List<Spot> all() {
        return deserialize(preferences.getString(PREFS_KEY, ""));
    }

    /** Persists the complete record synchronously so a successful return is durable app state. */
    public synchronized boolean put(Spot spot) {
        validateForPersistence(spot);
        List<Spot> records = new ArrayList<>(all());
        int existing = indexOfId(records, spot.id);
        if (existing >= 0) {
            records.set(existing, spot);
        } else {
            records.add(spot);
        }
        return preferences.edit().putString(PREFS_KEY, serialize(records)).commit();
    }

    public synchronized boolean remove(String id) {
        if (isBlank(id)) {
            return false;
        }
        List<Spot> records = new ArrayList<>(all());
        int existing = indexOfId(records, id);
        if (existing < 0) {
            return false;
        }
        records.remove(existing);
        return preferences.edit().putString(PREFS_KEY, serialize(records)).commit();
    }

    public synchronized boolean removeIfGenerationMatches(Spot expected) {
        if (expected == null) return false;
        List<Spot> records = new ArrayList<>(all());
        int index = indexOfId(records, expected.id);
        if (index < 0 || !sameGeneration(records.get(index), expected)) return false;
        records.remove(index);
        return preferences.edit().putString(PREFS_KEY, serialize(records)).commit();
    }

    public synchronized Resolution resolve(String phrase) {
        return resolve(all(), phrase);
    }

    public synchronized boolean markOpened(String id, long openedAtMs) {
        if (openedAtMs <= 0L) {
            throw new IllegalArgumentException("invalid_last_opened_at");
        }
        List<Spot> records = new ArrayList<>(all());
        int index = indexOfId(records, id);
        if (index < 0) {
            return false;
        }
        Spot current = records.get(index);
        records.set(index, current.withLastOpenedAt(openedAtMs));
        return preferences.edit().putString(PREFS_KEY, serialize(records)).commit();
    }

    public synchronized boolean attachGatewayBookmarkId(String id, String gatewayBookmarkId) {
        if (isBlank(id) || gatewayBookmarkId == null
                || !gatewayBookmarkId.matches("[A-Za-z0-9_-]{1,120}")) return false;
        List<Spot> records = new ArrayList<>(all());
        int index = indexOfId(records, id);
        if (index < 0) return false;
        records.set(index, records.get(index).withGatewayBookmarkId(gatewayBookmarkId));
        return preferences.edit().putString(PREFS_KEY, serialize(records)).commit();
    }

    public synchronized boolean attachGatewayBookmarkId(
            Spot expected, String gatewayBookmarkId) {
        if (expected == null || gatewayBookmarkId == null
                || !gatewayBookmarkId.matches("[A-Za-z0-9_-]{1,120}")) return false;
        List<Spot> records = new ArrayList<>(all());
        int index = indexOfId(records, expected.id);
        if (index < 0 || !sameGeneration(records.get(index), expected)) return false;
        records.set(index, records.get(index).withGatewayBookmarkId(gatewayBookmarkId));
        return preferences.edit().putString(PREFS_KEY, serialize(records)).commit();
    }

    static boolean sameGeneration(Spot left, Spot right) {
        return left != null && right != null && left.id.equals(right.id)
                && left.createdAtMs == right.createdAtMs && left.mediaId.equals(right.mediaId)
                && left.positionMs == right.positionMs;
    }

    static String serialize(List<Spot> records) {
        JSONObject root = new JSONObject();
        JSONArray items = new JSONArray();
        List<Spot> sorted = new ArrayList<>(records == null ? Collections.emptyList() : records);
        sorted.sort(Comparator.comparing(spot -> spot.id));
        try {
            root.put("version", SCHEMA_VERSION);
            for (Spot spot : sorted) {
                validateForPersistence(spot);
                items.put(toJson(spot));
            }
            root.put("spots", items);
            return root.toString();
        } catch (JSONException error) {
            throw new IllegalArgumentException("invalid_spot_json", error);
        }
    }

    static List<Spot> deserialize(String encoded) {
        if (isBlank(encoded)) {
            return Collections.emptyList();
        }
        try {
            JSONObject root = new JSONObject(encoded);
            int version = root.optInt("version", -1);
            if (version < 1 || version > SCHEMA_VERSION) {
                throw new IllegalArgumentException("unsupported_spot_store_version");
            }
            JSONArray items = root.optJSONArray("spots");
            if (items == null) {
                throw new IllegalArgumentException("invalid_spot_store_shape");
            }
            List<Spot> records = new ArrayList<>();
            Set<String> ids = new HashSet<>();
            for (int index = 0; index < items.length(); index++) {
                JSONObject item = items.optJSONObject(index);
                if (item == null) {
                    throw new IllegalArgumentException("invalid_spot_record");
                }
                Spot spot = fromJson(item);
                validateForPersistence(spot);
                if (!ids.add(spot.id)) {
                    throw new IllegalArgumentException("duplicate_spot_id");
                }
                records.add(spot);
            }
            records.sort(Comparator.comparing(spot -> spot.id));
            return Collections.unmodifiableList(records);
        } catch (JSONException error) {
            throw new IllegalArgumentException("invalid_spot_store_json", error);
        }
    }

    static Resolution resolve(List<Spot> records, String phrase) {
        String normalizedQuery = normalize(phrase);
        if (normalizedQuery.isEmpty()) {
            return Resolution.notFound("empty_query");
        }
        List<Spot> candidates = sortedValidRecords(records);

        List<ScoredSpot> exact = new ArrayList<>();
        for (Spot spot : candidates) {
            if (normalizedQuery.equals(normalize(spot.label))) {
                exact.add(new ScoredSpot(spot, 1.0d));
            }
        }
        if (!exact.isEmpty()) {
            return decide(exact, MatchType.EXACT_LABEL, 1.0d);
        }

        List<ScoredSpot> contained = new ArrayList<>();
        for (Spot spot : candidates) {
            String label = normalize(spot.label);
            if (containsPhrase(normalizedQuery, label) || containsPhrase(label, normalizedQuery)) {
                double specificity = (double) tokens(label, false).size()
                        / Math.max(1, tokens(normalizedQuery, false).size());
                contained.add(new ScoredSpot(spot, Math.min(1.0d, specificity)));
            }
        }
        if (!contained.isEmpty()) {
            return decide(contained, MatchType.PHRASE_CONTAINMENT, 0.0d);
        }

        List<ScoredSpot> tokenMatches = new ArrayList<>();
        for (Spot spot : candidates) {
            double score = weightedTokenScore(normalizedQuery, spot);
            if (score + SCORE_EPSILON >= TOKEN_MATCH_THRESHOLD) {
                tokenMatches.add(new ScoredSpot(spot, score));
            }
        }
        if (tokenMatches.isEmpty()) {
            return Resolution.notFound("below_token_threshold");
        }
        return decide(tokenMatches, MatchType.WEIGHTED_TOKENS, TOKEN_MATCH_THRESHOLD);
    }

    public static String canonicalYouTubeWatchUri(String videoId) {
        if (!isValidYouTubeVideoId(videoId)) {
            throw new IllegalArgumentException("invalid_youtube_video_id");
        }
        return "https://www.youtube.com/watch?v=" + videoId;
    }

    public static boolean isValidYouTubeVideoId(String videoId) {
        return videoId != null && YOUTUBE_VIDEO_ID.matcher(videoId).matches();
    }

    private static Resolution decide(List<ScoredSpot> candidates, MatchType type, double threshold) {
        candidates.sort(Comparator.comparingDouble((ScoredSpot item) -> item.score).reversed()
                .thenComparing(item -> item.spot.id));
        double best = candidates.get(0).score;
        List<Spot> tied = new ArrayList<>();
        for (ScoredSpot candidate : candidates) {
            if (Math.abs(candidate.score - best) <= SCORE_EPSILON) {
                tied.add(candidate.spot);
            }
        }
        if (tied.size() > 1) {
            return Resolution.ambiguous(type, best, threshold, tied);
        }
        return Resolution.match(type, best, threshold, candidates.get(0).spot);
    }

    private static double weightedTokenScore(String query, Spot spot) {
        Set<String> queryTokens = tokens(query, true);
        if (queryTokens.isEmpty()) {
            queryTokens = tokens(query, false);
        }
        return 0.60d * overlap(queryTokens, tokens(spot.label, false))
                + 0.20d * overlap(queryTokens, tokens(spot.note, false))
                + 0.15d * overlap(queryTokens, tokens(spot.title, false))
                + 0.05d * overlap(queryTokens, tokens(spot.packageName + " " + spot.instance, false));
    }

    private static double overlap(Set<String> query, Set<String> field) {
        if (query.isEmpty() || field.isEmpty()) {
            return 0.0d;
        }
        int matched = 0;
        for (String token : query) {
            if (field.contains(token)) {
                matched++;
            }
        }
        return (double) matched / query.size();
    }

    private static boolean containsPhrase(String text, String phrase) {
        return !phrase.isEmpty() && (" " + text + " ").contains(" " + phrase + " ");
    }

    private static Set<String> tokens(String text, boolean removeFiller) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        for (String token : normalize(text).split(" ")) {
            if (!token.isEmpty() && (!removeFiller || !QUERY_FILLER.contains(token))) {
                result.add(token);
            }
        }
        return result;
    }

    private static String normalize(String value) {
        if (value == null) {
            return "";
        }
        String decomposed = Normalizer.normalize(value, Normalizer.Form.NFKD)
                .toLowerCase(Locale.ROOT);
        StringBuilder result = new StringBuilder(decomposed.length());
        boolean previousSpace = true;
        for (int offset = 0; offset < decomposed.length();) {
            int codePoint = decomposed.codePointAt(offset);
            offset += Character.charCount(codePoint);
            if (Character.getType(codePoint) == Character.NON_SPACING_MARK) {
                continue;
            }
            if (Character.isLetterOrDigit(codePoint)) {
                result.appendCodePoint(codePoint);
                previousSpace = false;
            } else if (!previousSpace) {
                result.append(' ');
                previousSpace = true;
            }
        }
        int length = result.length();
        if (length > 0 && result.charAt(length - 1) == ' ') {
            result.setLength(length - 1);
        }
        return result.toString();
    }

    private static JSONObject toJson(Spot spot) throws JSONException {
        JSONObject item = new JSONObject()
                .put("version", SCHEMA_VERSION)
                .put("id", spot.id)
                .put("label", spot.label)
                .put("note", spot.note)
                .put("title", spot.title)
                .put("package", spot.packageName)
                .put("instance", spot.instance)
                .put("media_id", spot.mediaId)
                .put("media_uri", canonicalYouTubeWatchUri(spot.mediaId))
                .put("position", spot.positionMs)
                .put("duration", spot.durationMs)
                .put("identity_strength", spot.identityStrength)
                .put("created_at", spot.createdAtMs)
                .put("updated_at", spot.updatedAtMs);
        if (!isBlank(spot.gatewayBookmarkId)) item.put("gateway_bookmark_id", spot.gatewayBookmarkId);
        if (spot.lastOpenedAtMs != null) {
            item.put("last_opened_at", spot.lastOpenedAtMs);
        }
        return item;
    }

    private static Spot fromJson(JSONObject item) throws JSONException {
        int version = item.optInt("version", 1);
        if (version < 1 || version > SCHEMA_VERSION) {
            throw new IllegalArgumentException("unsupported_spot_record_version");
        }
        Object lastOpened = item.opt("last_opened_at");
        Long lastOpenedAtMs = lastOpened instanceof Number ? ((Number) lastOpened).longValue() : null;
        return new Spot(
                requiredString(item, "id"),
                requiredString(item, "label"),
                item.optString("note", ""),
                requiredString(item, "title"),
                requiredString(item, "package"),
                item.optString("instance", ""),
                requiredString(item, "media_id"),
                item.optString("media_uri", ""),
                requiredLong(item, "position"),
                requiredLong(item, "duration"),
                requiredString(item, "identity_strength"),
                requiredLong(item, "created_at"),
                requiredLong(item, "updated_at"),
                lastOpenedAtMs,
                item.optString("gateway_bookmark_id", "")
        );
    }

    private static String requiredString(JSONObject item, String key) throws JSONException {
        Object value = item.get(key);
        if (!(value instanceof String) || isBlank((String) value)) {
            throw new IllegalArgumentException("invalid_" + key);
        }
        return (String) value;
    }

    private static long requiredLong(JSONObject item, String key) throws JSONException {
        Object value = item.get(key);
        if (!(value instanceof Number)) {
            throw new IllegalArgumentException("invalid_" + key);
        }
        return ((Number) value).longValue();
    }

    private static void validateForPersistence(Spot spot) {
        if (spot == null || isBlank(spot.id) || isBlank(spot.label) || isBlank(spot.title)
                || isBlank(spot.packageName)) {
            throw new IllegalArgumentException("incomplete_spot");
        }
        if (!isValidYouTubeVideoId(spot.mediaId)) {
            throw new IllegalArgumentException("invalid_youtube_video_id");
        }
        String canonicalUri = canonicalYouTubeWatchUri(spot.mediaId);
        if (!canonicalUri.equals(spot.mediaUri)) {
            throw new IllegalArgumentException("noncanonical_media_uri");
        }
        if (!Set.of("canonical_uri", "session_media_id", "adapter_extracted", "gateway_synced")
                .contains(spot.identityStrength)) {
            throw new IllegalArgumentException("weak_media_identity");
        }
        if (spot.positionMs < 0L || spot.durationMs < 0L
                || (spot.durationMs > 0L && spot.positionMs > spot.durationMs)) {
            throw new IllegalArgumentException("invalid_media_position");
        }
        if (spot.createdAtMs <= 0L || spot.updatedAtMs < spot.createdAtMs
                || (spot.lastOpenedAtMs != null && spot.lastOpenedAtMs < spot.createdAtMs)) {
            throw new IllegalArgumentException("invalid_spot_timestamps");
        }
        if (!isBlank(spot.gatewayBookmarkId)
                && !spot.gatewayBookmarkId.matches("[A-Za-z0-9_-]{1,120}")) {
            throw new IllegalArgumentException("invalid_gateway_bookmark_id");
        }
    }

    private static List<Spot> sortedValidRecords(List<Spot> records) {
        List<Spot> result = new ArrayList<>();
        if (records != null) {
            for (Spot spot : records) {
                validateForPersistence(spot);
                result.add(spot);
            }
        }
        result.sort(Comparator.comparing(spot -> spot.id));
        return result;
    }

    private static int indexOfId(List<Spot> records, String id) {
        for (int index = 0; index < records.size(); index++) {
            if (records.get(index).id.equals(id)) {
                return index;
            }
        }
        return -1;
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    public static final class Spot {
        public final String id;
        public final String label;
        public final String note;
        public final String title;
        public final String packageName;
        public final String instance;
        public final String mediaId;
        public final String mediaUri;
        public final long positionMs;
        public final long durationMs;
        public final String identityStrength;
        public final long createdAtMs;
        public final long updatedAtMs;
        public final Long lastOpenedAtMs;
        public final String gatewayBookmarkId;

        public Spot(
                String id,
                String label,
                String note,
                String title,
                String packageName,
                String instance,
                String mediaId,
                String mediaUri,
                long positionMs,
                long durationMs,
                String identityStrength,
                long createdAtMs,
                long updatedAtMs,
                Long lastOpenedAtMs
        ) {
            this(id, label, note, title, packageName, instance, mediaId, mediaUri,
                    positionMs, durationMs, identityStrength, createdAtMs, updatedAtMs,
                    lastOpenedAtMs, "");
        }

        public Spot(
                String id, String label, String note, String title, String packageName,
                String instance, String mediaId, String mediaUri, long positionMs,
                long durationMs, String identityStrength, long createdAtMs, long updatedAtMs,
                Long lastOpenedAtMs, String gatewayBookmarkId
        ) {
            this.id = id;
            this.label = label;
            this.note = note == null ? "" : note;
            this.title = title;
            this.packageName = packageName;
            this.instance = instance == null ? "" : instance;
            this.mediaId = mediaId;
            this.mediaUri = mediaUri;
            this.positionMs = positionMs;
            this.durationMs = durationMs;
            this.identityStrength = identityStrength;
            this.createdAtMs = createdAtMs;
            this.updatedAtMs = updatedAtMs;
            this.lastOpenedAtMs = lastOpenedAtMs;
            this.gatewayBookmarkId = gatewayBookmarkId == null ? "" : gatewayBookmarkId;
        }

        public Spot withLastOpenedAt(long openedAtMs) {
            return new Spot(id, label, note, title, packageName, instance, mediaId, mediaUri,
                    positionMs, durationMs, identityStrength, createdAtMs,
                    Math.max(updatedAtMs, openedAtMs), openedAtMs, gatewayBookmarkId);
        }

        public Spot withGatewayBookmarkId(String value) {
            return new Spot(id, label, note, title, packageName, instance, mediaId, mediaUri,
                    positionMs, durationMs, identityStrength, createdAtMs,
                    updatedAtMs, lastOpenedAtMs, value);
        }
    }

    public enum ResolutionStatus { MATCH, NOT_FOUND, AMBIGUOUS }
    public enum MatchType { EXACT_LABEL, PHRASE_CONTAINMENT, WEIGHTED_TOKENS }

    public static final class Resolution {
        public final ResolutionStatus status;
        public final MatchType matchType;
        public final double score;
        public final double threshold;
        public final String reason;
        public final Spot spot;
        public final List<Spot> candidates;

        private Resolution(ResolutionStatus status, MatchType matchType, double score,
                           double threshold, String reason, Spot spot, List<Spot> candidates) {
            this.status = status;
            this.matchType = matchType;
            this.score = score;
            this.threshold = threshold;
            this.reason = reason;
            this.spot = spot;
            this.candidates = Collections.unmodifiableList(new ArrayList<>(candidates));
        }

        static Resolution match(MatchType type, double score, double threshold, Spot spot) {
            return new Resolution(ResolutionStatus.MATCH, type, score, threshold, "matched",
                    spot, List.of(spot));
        }

        static Resolution ambiguous(MatchType type, double score, double threshold, List<Spot> spots) {
            return new Resolution(ResolutionStatus.AMBIGUOUS, type, score, threshold,
                    "ambiguous", null, spots);
        }

        static Resolution notFound(String reason) {
            return new Resolution(ResolutionStatus.NOT_FOUND, null, 0.0d,
                    TOKEN_MATCH_THRESHOLD, reason, null, Collections.emptyList());
        }
    }

    private static final class ScoredSpot {
        final Spot spot;
        final double score;

        ScoredSpot(Spot spot, double score) {
            this.spot = spot;
            this.score = score;
        }
    }
}

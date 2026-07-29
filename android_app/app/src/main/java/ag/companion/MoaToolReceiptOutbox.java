package ag.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Durable, bounded retry state for Android-owned cross-device tool receipts. */
final class MoaToolReceiptOutbox {
    static final int MAX_PENDING_RECORDS = 64;

    private static final Object PROCESS_LOCK = new Object();
    private static final String PREFS_NAME = "moa_tool_receipt_outbox";
    private static final String PREFS_KEY = "state_json";
    private static final int SCHEMA_VERSION = 1;
    private static final int MAX_SUMMARY_CHARS = 1000;
    private static final int MAX_BODY_BYTES = 8192;
    private static final int MAX_STATE_BYTES = 524288;
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$");
    private static final Pattern TOOL = Pattern.compile("^[a-z][a-z0-9_.-]{0,119}$");
    private static final Pattern POLICY = Pattern.compile("^[A-Za-z0-9_.-]{1,120}$");
    private static final Pattern SHA256 = Pattern.compile("^[a-fA-F0-9]{64}$");
    private static final Pattern BEARER = Pattern.compile(
            "(?i)\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}");
    private static final Pattern SECRET_ASSIGNMENT = Pattern.compile(
            "(?i)(\\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|authorization|secret)"
                    + "\\s*[:=]\\s*[\\\"']?)[^\\s,\\\"'&]{4,}");
    private static final Pattern SECRET_QUERY = Pattern.compile(
            "(?i)([?&](?:access_token|refresh_token|token|api_key|apikey|key|secret)=)[^&#\\s]*");
    private static final Pattern JWT = Pattern.compile(
            "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b");
    private static final Pattern PROVIDER_KEY = Pattern.compile(
            "\\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{12,})\\b");

    private final DurableState durableState;
    private final LongSupplier clock;

    MoaToolReceiptOutbox(Context context) {
        if (context == null) throw new IllegalArgumentException("context_required");
        Context appContext = context.getApplicationContext();
        SharedPreferences preferences = (appContext == null ? context : appContext)
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.durableState = new SharedPreferencesState(preferences);
        this.clock = System::currentTimeMillis;
    }

    MoaToolReceiptOutbox(DurableState durableState, LongSupplier clock) {
        if (durableState == null || clock == null) {
            throw new IllegalArgumentException("outbox_dependencies_required");
        }
        this.durableState = durableState;
        this.clock = clock;
    }

    Reservation reserve(String requestId, String claimId, String deviceId) {
        if (!validId(requestId) || !validId(claimId) || !validId(deviceId)) {
            return Reservation.failure(ReservationStatus.INVALID, "invalid_receipt_identity");
        }
        synchronized (PROCESS_LOCK) {
            Loaded loaded = load();
            if (!loaded.healthy) {
                return Reservation.failure(ReservationStatus.CORRUPT, loaded.error);
            }
            Record existing = findRequest(loaded.records, requestId);
            if (existing != null) {
                if (!existing.deviceId.equals(deviceId) || !existing.claimId.equals(claimId)) {
                    return Reservation.failure(ReservationStatus.COLLISION, "request_claim_collision");
                }
                ReservationStatus status = "pending".equals(existing.status)
                        ? ReservationStatus.RETRY_PENDING : ReservationStatus.UNCERTAIN_RESERVED;
                return Reservation.existing(status, existing);
            }
            if (loaded.records.size() >= MAX_PENDING_RECORDS) {
                return Reservation.failure(ReservationStatus.CAPACITY, "receipt_outbox_full");
            }
            long nowMs = clock.getAsLong();
            if (nowMs <= 0L) {
                return Reservation.failure(ReservationStatus.INVALID, "invalid_receipt_time");
            }
            Record record = Record.reserved(requestId,
                    receiptId(requestId, claimId, deviceId), claimId, deviceId, nowMs);
            List<Record> next = new ArrayList<>(loaded.records);
            next.add(record);
            if (!persist(next)) {
                return Reservation.failure(ReservationStatus.DURABILITY_FAILED,
                        "receipt_reservation_not_durable");
            }
            return Reservation.created(record);
        }
    }

    Completion complete(Reservation reservation, String tool, boolean ok, String summary,
            JSONObject localReceipt) {
        if (reservation == null || !validId(reservation.requestId)
                || !validId(reservation.receiptId) || !TOOL.matcher(safe(tool)).matches()) {
            return Completion.failure(CompletionStatus.INVALID, "invalid_receipt_completion");
        }
        synchronized (PROCESS_LOCK) {
            Loaded loaded = load();
            if (!loaded.healthy) {
                return Completion.failure(CompletionStatus.CORRUPT, loaded.error);
            }
            Record current = findRequest(loaded.records, reservation.requestId);
            if (current == null) {
                return Completion.failure(CompletionStatus.NOT_FOUND, "receipt_reservation_missing");
            }
            if (!current.receiptId.equals(reservation.receiptId)
                    || !current.claimId.equals(reservation.claimId)
                    || !current.deviceId.equals(reservation.deviceId)) {
                return Completion.failure(CompletionStatus.COLLISION, "receipt_reservation_mismatch");
            }
            PendingReceipt pending;
            try {
                pending = buildPending(current, tool, ok, summary, localReceipt);
            } catch (IllegalArgumentException error) {
                return Completion.failure(CompletionStatus.INVALID, error.getMessage());
            }
            if ("pending".equals(current.status)) {
                if (current.bodyDigest.equals(pending.bodyDigest)
                        && current.bodyJson.equals(pending.bodyJson)) {
                    return Completion.pending(pending, false);
                }
                return Completion.failure(CompletionStatus.COLLISION,
                        "terminal_receipt_collision");
            }
            List<Record> next = new ArrayList<>(loaded.records);
            int index = indexOfRequest(next, current.requestId);
            next.set(index, current.pending(pending.bodyDigest, pending.bodyJson));
            if (!persist(next)) {
                return Completion.failure(CompletionStatus.DURABILITY_FAILED,
                        "terminal_receipt_not_durable");
            }
            return Completion.pending(pending, true);
        }
    }

    Snapshot snapshot() {
        synchronized (PROCESS_LOCK) {
            Loaded loaded = load();
            if (!loaded.healthy) return Snapshot.corrupt(loaded.error);
            List<PendingReceipt> pending = new ArrayList<>();
            List<Reservation> uncertain = new ArrayList<>();
            for (Record record : loaded.records) {
                if ("pending".equals(record.status)) pending.add(record.asPending());
                else uncertain.add(Reservation.existing(ReservationStatus.UNCERTAIN_RESERVED, record));
            }
            pending.sort(Comparator.comparing(item -> item.requestId));
            uncertain.sort(Comparator.comparing(item -> item.requestId));
            return Snapshot.healthy(pending, uncertain);
        }
    }

    AckResult acknowledge(PendingReceipt pending, Acknowledgement acknowledgement) {
        if (pending == null || acknowledgement == null || !acknowledgement.accepted) {
            return AckResult.NOT_ACCEPTED;
        }
        if (!pending.requestId.equals(acknowledgement.requestId)
                || !pending.receiptId.equals(acknowledgement.receiptId)
                || !pending.bodyDigest.equals(acknowledgement.bodyDigest)) {
            return AckResult.MISMATCH;
        }
        synchronized (PROCESS_LOCK) {
            Loaded loaded = load();
            if (!loaded.healthy) return AckResult.CORRUPT;
            Record current = findRequest(loaded.records, pending.requestId);
            if (current == null) return AckResult.NOT_FOUND;
            if (!"pending".equals(current.status)
                    || !current.receiptId.equals(pending.receiptId)
                    || !current.bodyDigest.equals(pending.bodyDigest)
                    || !current.bodyJson.equals(pending.bodyJson)) {
                return AckResult.MISMATCH;
            }
            List<Record> next = new ArrayList<>(loaded.records);
            next.remove(indexOfRequest(next, pending.requestId));
            return persist(next) ? AckResult.REMOVED : AckResult.DURABILITY_FAILED;
        }
    }

    static Acknowledgement gatewayAcknowledgement(PendingReceipt pending, JSONObject response) {
        if (pending == null || response == null) return Acknowledgement.rejected();
        JSONObject receipt = response.optJSONObject("receipt");
        if (receipt == null) {
            JSONObject request = response.optJSONObject("request");
            if (request != null) receipt = request.optJSONObject("latest_receipt");
        }
        JSONObject local = receipt == null ? null : receipt.optJSONObject("local_receipt");
        if (local == null) local = response.optJSONObject("acknowledgement");
        if (local == null
                || !pending.requestId.equals(local.optString("request_id", ""))
                || !pending.receiptId.equals(local.optString("receipt_id", ""))
                || !pending.bodyDigest.equals(local.optString("body_digest", ""))) {
            return Acknowledgement.rejected();
        }
        return Acknowledgement.accepted(pending.requestId, pending.receiptId,
                pending.bodyDigest, response.optBoolean("idempotent", false));
    }

    private PendingReceipt buildPending(Record record, String tool, boolean ok, String summary,
            JSONObject localReceipt) {
        String safeTool = safe(tool);
        if (!TOOL.matcher(safeTool).matches()) throw invalid("invalid_receipt_tool");
        if (localReceipt != null) {
            String localTool = safe(localReceipt.optString("tool", ""));
            if (!localTool.isEmpty() && !safeTool.equals(localTool)) {
                throw invalid("local_receipt_tool_mismatch");
            }
            if (localReceipt.has("success") && localReceipt.optBoolean("success") != ok) {
                throw invalid("local_receipt_result_mismatch");
            }
        }
        String safeSummary = truncate(redactPotentialSecrets(safe(summary)), MAX_SUMMARY_CHARS);
        if (safeSummary.isEmpty()) safeSummary = ok ? "Completed." : "Failed.";
        JSONObject body = new JSONObject();
        try {
            body.put("request_id", record.requestId);
            body.put("receipt_id", record.receiptId);
            body.put("claim_id", record.claimId);
            body.put("device_id", record.deviceId);
            body.put("ok", ok);
            body.put("summary", safeSummary);
            if (!ok) body.put("error", safeSummary);
            body.put("result", new JSONObject().put("reply", safeSummary));
            JSONObject local = localReceiptProjection(
                    record.requestId, record.receiptId, safeTool, ok, localReceipt);
            body.put("local_receipt", local);
            String digest = sha256(canonicalJson(body));
            body.put("body_digest", digest);
            local.put("body_digest", digest);
            String bodyJson = canonicalJson(body);
            if (bodyJson.getBytes(StandardCharsets.UTF_8).length > MAX_BODY_BYTES) {
                throw invalid("terminal_receipt_too_large");
            }
            return new PendingReceipt(record.requestId, record.receiptId, record.claimId, record.deviceId,
                    record.createdAtMs, digest, bodyJson);
        } catch (JSONException error) {
            throw invalid("invalid_terminal_receipt_json");
        }
    }

    private static JSONObject localReceiptProjection(String requestId, String receiptId,
            String tool, boolean ok, JSONObject source) throws JSONException {
        JSONObject result = new JSONObject()
                .put("version", SCHEMA_VERSION)
                .put("request_id", requestId)
                .put("receipt_id", receiptId)
                .put("tool", tool)
                .put("success", ok);
        if (source == null) return result;
        String risk = safe(source.optString("risk", ""));
        String approval = safe(source.optString("approval", ""));
        String outcome = safe(source.optString("outcome", ""));
        String localHash = safe(source.optString("hash", ""));
        long recordedAtMs = source.optLong("timestamp_ms", 0L);
        if (!risk.isEmpty() && POLICY.matcher(risk).matches()) result.put("risk", risk);
        if (!approval.isEmpty() && POLICY.matcher(approval).matches()) result.put("approval", approval);
        if (!outcome.isEmpty() && POLICY.matcher(outcome).matches()) result.put("outcome", outcome);
        if (SHA256.matcher(localHash).matches()) {
            result.put("local_hash", localHash.toLowerCase(Locale.ROOT));
        }
        if (recordedAtMs > 0L) result.put("recorded_at_ms", recordedAtMs);
        return result;
    }

    private Loaded load() {
        String encoded;
        try {
            encoded = durableState.read();
        } catch (RuntimeException error) {
            return Loaded.corrupt("receipt_outbox_read_failed");
        }
        if (encoded == null || encoded.isEmpty()) return Loaded.healthy(Collections.emptyList());
        if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_STATE_BYTES) {
            return Loaded.corrupt("receipt_outbox_too_large");
        }
        try {
            JSONObject root = new JSONObject(encoded);
            if (root.optInt("version", -1) != SCHEMA_VERSION) {
                throw invalid("unsupported_receipt_outbox_version");
            }
            JSONArray items = root.optJSONArray("records");
            if (items == null || items.length() > MAX_PENDING_RECORDS) {
                throw invalid("invalid_receipt_outbox_shape");
            }
            List<Record> records = new ArrayList<>();
            Set<String> requestIds = new HashSet<>();
            Set<String> receiptIds = new HashSet<>();
            for (int index = 0; index < items.length(); index++) {
                JSONObject item = items.optJSONObject(index);
                Record record = parseRecord(item);
                if (!requestIds.add(record.requestId) || !receiptIds.add(record.receiptId)) {
                    throw invalid("duplicate_receipt_outbox_identity");
                }
                records.add(record);
            }
            records.sort(Comparator.comparing(item -> item.requestId));
            return Loaded.healthy(records);
        } catch (JSONException | IllegalArgumentException error) {
            return Loaded.corrupt(safe(error.getMessage()).isEmpty()
                    ? "corrupt_receipt_outbox" : safe(error.getMessage()));
        }
    }

    private boolean persist(List<Record> records) {
        String encoded;
        try {
            encoded = serialize(records);
        } catch (IllegalArgumentException error) {
            return false;
        }
        boolean reported;
        try {
            reported = durableState.write(encoded);
        } catch (RuntimeException error) {
            reported = false;
        }
        if (reported) return true;
        try {
            return encoded.equals(durableState.read());
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String serialize(List<Record> records) {
        List<Record> sorted = new ArrayList<>(records);
        sorted.sort(Comparator.comparing(item -> item.requestId));
        JSONArray items = new JSONArray();
        for (Record record : sorted) items.put(record.toJson());
        try {
            String encoded = canonicalJson(new JSONObject()
                    .put("version", SCHEMA_VERSION).put("records", items));
            if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_STATE_BYTES) {
                throw invalid("receipt_outbox_too_large");
            }
            return encoded;
        } catch (JSONException error) {
            throw invalid("invalid_receipt_outbox_json");
        }
    }

    private static Record parseRecord(JSONObject item) {
        if (item == null || item.optInt("version", -1) != SCHEMA_VERSION) {
            throw invalid("invalid_receipt_outbox_record");
        }
        String status = requiredString(item, "status");
        String requestId = requiredString(item, "request_id");
        String receiptId = requiredString(item, "receipt_id");
        String claimId = requiredString(item, "claim_id");
        String deviceId = requiredString(item, "device_id");
        long createdAtMs = requiredLong(item, "created_at_ms");
        if (!("reserved".equals(status) || "pending".equals(status))
                || !validId(requestId) || !validId(receiptId) || !validId(claimId) || !validId(deviceId)
                || createdAtMs <= 0L || !receiptId.equals(receiptId(requestId, claimId, deviceId))) {
            throw invalid("invalid_receipt_outbox_record");
        }
        if ("reserved".equals(status)) {
            return Record.reserved(requestId, receiptId, claimId, deviceId, createdAtMs);
        }
        String bodyDigest = requiredString(item, "body_digest");
        String bodyJson = requiredString(item, "body_json");
        if (!SHA256.matcher(bodyDigest).matches()
                || bodyJson.getBytes(StandardCharsets.UTF_8).length > MAX_BODY_BYTES) {
            throw invalid("invalid_pending_receipt");
        }
        validateBody(requestId, receiptId, claimId, deviceId, bodyDigest, bodyJson);
        return Record.pending(requestId, receiptId, claimId, deviceId, createdAtMs,
                bodyDigest.toLowerCase(Locale.ROOT), bodyJson);
    }

    private static void validateBody(String requestId, String receiptId, String claimId, String deviceId,
            String expectedDigest, String bodyJson) {
        try {
            JSONObject body = new JSONObject(bodyJson);
            if (!requestId.equals(body.optString("request_id", ""))
                    || !receiptId.equals(body.optString("receipt_id", ""))
                    || !claimId.equals(body.optString("claim_id", ""))
                    || !deviceId.equals(body.optString("device_id", ""))
                    || !expectedDigest.equalsIgnoreCase(body.optString("body_digest", ""))) {
                throw invalid("pending_receipt_identity_mismatch");
            }
            JSONObject local = body.optJSONObject("local_receipt");
            if (local == null || !requestId.equals(local.optString("request_id", ""))
                    || !receiptId.equals(local.optString("receipt_id", ""))
                    || !expectedDigest.equalsIgnoreCase(local.optString("body_digest", ""))) {
                throw invalid("pending_local_receipt_mismatch");
            }
            body.remove("body_digest");
            local.remove("body_digest");
            String calculated = sha256(canonicalJson(body));
            if (!expectedDigest.equalsIgnoreCase(calculated)) {
                throw invalid("pending_receipt_digest_mismatch");
            }
        } catch (JSONException error) {
            throw invalid("invalid_pending_receipt_json");
        }
    }

    static String canonicalJson(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            List<String> entries = new ArrayList<>();
            for (String key : keys) {
                entries.add(JSONObject.quote(key) + ":" + canonicalJson(object.opt(key)));
            }
            return "{" + String.join(",", entries) + "}";
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            List<String> entries = new ArrayList<>();
            for (int index = 0; index < array.length(); index++) {
                entries.add(canonicalJson(array.opt(index)));
            }
            return "[" + String.join(",", entries) + "]";
        }
        if (value instanceof String) return JSONObject.quote((String) value);
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Number) {
            try {
                return JSONObject.numberToString((Number) value);
            } catch (JSONException error) {
                throw invalid("invalid_json_number");
            }
        }
        throw invalid("unsupported_json_value");
    }

    private static String redactPotentialSecrets(String value) {
        String redacted = replace(BEARER, value, "[redacted]");
        redacted = replace(SECRET_ASSIGNMENT, redacted, "$1[redacted]");
        redacted = replace(SECRET_QUERY, redacted, "$1[redacted]");
        redacted = replace(JWT, redacted, "[redacted]");
        return replace(PROVIDER_KEY, redacted, "[redacted]");
    }

    private static String replace(Pattern pattern, String value, String replacement) {
        Matcher matcher = pattern.matcher(value);
        return matcher.find() ? matcher.replaceAll(replacement) : value;
    }

    private static String truncate(String value, int maxChars) {
        if (value.length() <= maxChars) return value;
        int end = value.offsetByCodePoints(0, Math.min(maxChars, value.codePointCount(0, value.length())));
        return value.substring(0, end);
    }

    private static String receiptId(String requestId, String claimId, String deviceId) {
        String digest = sha256("moa.android.tool-receipt.v1\n" + requestId + "\n"
                + claimId + "\n" + deviceId);
        return "receipt_" + digest.substring(0, 40);
    }

    private static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) result.append(String.format(Locale.ROOT, "%02x", item));
            return result.toString();
        } catch (Exception error) {
            throw new IllegalStateException("sha256_unavailable", error);
        }
    }

    private static Record findRequest(List<Record> records, String requestId) {
        int index = indexOfRequest(records, requestId);
        return index < 0 ? null : records.get(index);
    }

    private static int indexOfRequest(List<Record> records, String requestId) {
        for (int index = 0; index < records.size(); index++) {
            if (records.get(index).requestId.equals(requestId)) return index;
        }
        return -1;
    }

    private static boolean validId(String value) {
        return value != null && ID.matcher(value).matches();
    }

    private static String requiredString(JSONObject item, String key) {
        Object value = item.opt(key);
        if (!(value instanceof String) || ((String) value).isEmpty()) {
            throw invalid("invalid_" + key);
        }
        return (String) value;
    }

    private static long requiredLong(JSONObject item, String key) {
        Object value = item.opt(key);
        if (!(value instanceof Number)) throw invalid("invalid_" + key);
        return ((Number) value).longValue();
    }

    private static IllegalArgumentException invalid(String message) {
        return new IllegalArgumentException(message);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    interface DurableState {
        String read();
        boolean write(String encoded);
    }

    enum ReservationStatus {
        READY, RETRY_PENDING, UNCERTAIN_RESERVED, INVALID, COLLISION, CAPACITY,
        CORRUPT, DURABILITY_FAILED
    }

    enum CompletionStatus {
        PENDING, INVALID, NOT_FOUND, COLLISION, CORRUPT, DURABILITY_FAILED
    }

    enum AckResult {
        REMOVED, NOT_ACCEPTED, NOT_FOUND, MISMATCH, CORRUPT, DURABILITY_FAILED
    }

    static final class Reservation {
        final ReservationStatus status;
        final String requestId;
        final String receiptId;
        final String claimId;
        final String deviceId;
        final long createdAtMs;
        final String error;
        final boolean created;

        private Reservation(ReservationStatus status, String requestId, String receiptId,
                String claimId, String deviceId, long createdAtMs, String error, boolean created) {
            this.status = status;
            this.requestId = requestId;
            this.receiptId = receiptId;
            this.claimId = claimId;
            this.deviceId = deviceId;
            this.createdAtMs = createdAtMs;
            this.error = error;
            this.created = created;
        }

        boolean mayExecute() {
            return status == ReservationStatus.READY && created;
        }

        private static Reservation created(Record record) {
            return new Reservation(ReservationStatus.READY, record.requestId, record.receiptId,
                    record.claimId, record.deviceId, record.createdAtMs, "", true);
        }

        private static Reservation existing(ReservationStatus status, Record record) {
            return new Reservation(status, record.requestId, record.receiptId, record.claimId, record.deviceId,
                    record.createdAtMs, "", false);
        }

        private static Reservation failure(ReservationStatus status, String error) {
            return new Reservation(status, "", "", "", "", 0L, safe(error), false);
        }
    }

    static final class Completion {
        final CompletionStatus status;
        final PendingReceipt pending;
        final String error;
        final boolean newlyPersisted;

        private Completion(CompletionStatus status, PendingReceipt pending, String error,
                boolean newlyPersisted) {
            this.status = status;
            this.pending = pending;
            this.error = error;
            this.newlyPersisted = newlyPersisted;
        }

        boolean readyToSend() {
            return status == CompletionStatus.PENDING && pending != null;
        }

        private static Completion pending(PendingReceipt pending, boolean newlyPersisted) {
            return new Completion(CompletionStatus.PENDING, pending, "", newlyPersisted);
        }

        private static Completion failure(CompletionStatus status, String error) {
            return new Completion(status, null, safe(error), false);
        }
    }

    static final class PendingReceipt {
        final String requestId;
        final String receiptId;
        final String claimId;
        final String deviceId;
        final long createdAtMs;
        final String bodyDigest;
        final String bodyJson;

        private PendingReceipt(String requestId, String receiptId, String claimId, String deviceId,
                long createdAtMs, String bodyDigest, String bodyJson) {
            this.requestId = requestId;
            this.receiptId = receiptId;
            this.claimId = claimId;
            this.deviceId = deviceId;
            this.createdAtMs = createdAtMs;
            this.bodyDigest = bodyDigest;
            this.bodyJson = bodyJson;
        }

        JSONObject body() {
            try {
                return new JSONObject(bodyJson);
            } catch (JSONException error) {
                throw new IllegalStateException("persisted_receipt_invalid", error);
            }
        }
    }

    static final class Snapshot {
        final boolean healthy;
        final String error;
        final List<PendingReceipt> pending;
        final List<Reservation> uncertainReservations;

        private Snapshot(boolean healthy, String error, List<PendingReceipt> pending,
                List<Reservation> uncertainReservations) {
            this.healthy = healthy;
            this.error = error;
            this.pending = pending;
            this.uncertainReservations = uncertainReservations;
        }

        private static Snapshot healthy(List<PendingReceipt> pending,
                List<Reservation> uncertainReservations) {
            return new Snapshot(true, "", Collections.unmodifiableList(pending),
                    Collections.unmodifiableList(uncertainReservations));
        }

        private static Snapshot corrupt(String error) {
            return new Snapshot(false, safe(error), Collections.emptyList(), Collections.emptyList());
        }
    }

    static final class Acknowledgement {
        final boolean accepted;
        final boolean idempotent;
        final String requestId;
        final String receiptId;
        final String bodyDigest;

        private Acknowledgement(boolean accepted, boolean idempotent, String requestId,
                String receiptId, String bodyDigest) {
            this.accepted = accepted;
            this.idempotent = idempotent;
            this.requestId = requestId;
            this.receiptId = receiptId;
            this.bodyDigest = bodyDigest;
        }

        static Acknowledgement accepted(String requestId, String receiptId,
                String bodyDigest, boolean idempotent) {
            if (!validId(requestId) || !validId(receiptId) || !SHA256.matcher(bodyDigest).matches()) {
                return rejected();
            }
            return new Acknowledgement(true, idempotent, requestId, receiptId,
                    bodyDigest.toLowerCase(Locale.ROOT));
        }

        static Acknowledgement rejected() {
            return new Acknowledgement(false, false, "", "", "");
        }
    }

    private static final class Record {
        final String status;
        final String requestId;
        final String receiptId;
        final String claimId;
        final String deviceId;
        final long createdAtMs;
        final String bodyDigest;
        final String bodyJson;

        private Record(String status, String requestId, String receiptId, String claimId, String deviceId,
                long createdAtMs, String bodyDigest, String bodyJson) {
            this.status = status;
            this.requestId = requestId;
            this.receiptId = receiptId;
            this.claimId = claimId;
            this.deviceId = deviceId;
            this.createdAtMs = createdAtMs;
            this.bodyDigest = bodyDigest;
            this.bodyJson = bodyJson;
        }

        private static Record reserved(String requestId, String receiptId, String claimId, String deviceId,
                long createdAtMs) {
            return new Record("reserved", requestId, receiptId, claimId, deviceId, createdAtMs, "", "");
        }

        private static Record pending(String requestId, String receiptId, String claimId, String deviceId,
                long createdAtMs, String bodyDigest, String bodyJson) {
            return new Record("pending", requestId, receiptId, claimId, deviceId, createdAtMs,
                    bodyDigest, bodyJson);
        }

        private Record pending(String bodyDigest, String bodyJson) {
            return pending(requestId, receiptId, claimId, deviceId, createdAtMs, bodyDigest, bodyJson);
        }

        private PendingReceipt asPending() {
            return new PendingReceipt(requestId, receiptId, claimId, deviceId, createdAtMs,
                    bodyDigest, bodyJson);
        }

        private JSONObject toJson() {
            try {
                JSONObject result = new JSONObject()
                        .put("version", SCHEMA_VERSION)
                        .put("status", status)
                        .put("request_id", requestId)
                        .put("receipt_id", receiptId)
                        .put("claim_id", claimId)
                        .put("device_id", deviceId)
                        .put("created_at_ms", createdAtMs);
                if ("pending".equals(status)) {
                    result.put("body_digest", bodyDigest).put("body_json", bodyJson);
                }
                return result;
            } catch (JSONException error) {
                throw invalid("invalid_receipt_outbox_record_json");
            }
        }
    }

    private static final class Loaded {
        final boolean healthy;
        final String error;
        final List<Record> records;

        private Loaded(boolean healthy, String error, List<Record> records) {
            this.healthy = healthy;
            this.error = error;
            this.records = records;
        }

        private static Loaded healthy(List<Record> records) {
            return new Loaded(true, "", records);
        }

        private static Loaded corrupt(String error) {
            return new Loaded(false, safe(error), Collections.emptyList());
        }
    }

    private static final class SharedPreferencesState implements DurableState {
        private final SharedPreferences preferences;

        private SharedPreferencesState(SharedPreferences preferences) {
            this.preferences = preferences;
        }

        @Override public String read() {
            return preferences.getString(PREFS_KEY, "");
        }

        @Override public boolean write(String encoded) {
            return preferences.edit().putString(PREFS_KEY, encoded).commit();
        }
    }
}

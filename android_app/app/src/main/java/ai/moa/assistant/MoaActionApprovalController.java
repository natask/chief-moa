package ai.moa.assistant;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Pure local authority for a claimed Android tool request.
 *
 * <p>The controller intentionally stores a digest instead of the request arguments. A caller
 * must present the arguments and foreground package again immediately before execution. Every
 * successful authorization and every fail-closed denial is terminal, so a request id can never
 * authorize more than one local effect.</p>
 */
final class MoaActionApprovalController {
    static final int MAX_CANONICAL_ARGS_BYTES = 16 * 1024;

    private static final int MAX_DEPTH = 8;
    private static final int MAX_CONTAINER_ENTRIES = 64;
    private static final int MAX_NODES = 512;
    private static final int MAX_STRING_CHARS = 4096;
    private static final int MAX_IDENTIFIER_CHARS = 256;

    private static final Set<String> IMPLICIT_TOOLS = Set.of(
            "app.launch",
            "contact.open",
            "media.control",
            "media.open",
            "screen.tap_text",
            "system.back",
            "system.home",
            "url.open"
    );
    private static final Set<String> READ_ONLY_PLAYLIST_OPERATIONS = Set.of(
            "get",
            "inspect",
            "list",
            "show"
    );

    private final Map<String, Record> records = new HashMap<>();

    synchronized Binding bind(
            String requestId,
            String tool,
            JSONObject args,
            String expectedPackage,
            long createdAtMillis,
            long expiresAtMillis
    ) {
        String id = requiredIdentifier(requestId, "request id");
        String normalizedTool = requiredIdentifier(tool, "tool").toLowerCase(Locale.US);
        String targetPackage = requiredIdentifier(expectedPackage, "expected package");
        if (expiresAtMillis <= createdAtMillis) {
            throw new IllegalArgumentException("expiry must be after creation");
        }
        if (records.containsKey(id)) {
            throw new IllegalStateException("request id is already bound");
        }

        ApprovalRequirement requirement = approvalRequirement(normalizedTool, args);
        if (requirement == ApprovalRequirement.BLOCKED) {
            throw new IllegalArgumentException("unsupported approval policy for tool: " + normalizedTool);
        }
        Binding binding = new Binding(
                id,
                normalizedTool,
                canonicalArgsDigest(args),
                targetPackage,
                createdAtMillis,
                expiresAtMillis,
                requirement
        );
        records.put(id, new Record(binding));
        return binding;
    }

    synchronized Decision authorizeImplicit(
            String requestId,
            JSONObject currentArgs,
            String currentPackage,
            long nowMillis
    ) {
        Record record = records.get(safe(requestId));
        Decision unavailable = unavailable(record);
        if (unavailable != null) {
            return unavailable;
        }
        if (record.binding.requirement != ApprovalRequirement.IMPLICIT) {
            return Decision.pending(Outcome.NEEDS_CONFIRMATION, record.binding);
        }
        return authorize(record, currentArgs, currentPackage, nowMillis);
    }

    synchronized Decision approve(
            String requestId,
            JSONObject currentArgs,
            String currentPackage,
            long nowMillis
    ) {
        Record record = records.get(safe(requestId));
        Decision unavailable = unavailable(record);
        if (unavailable != null) {
            return unavailable;
        }
        if (record.binding.requirement != ApprovalRequirement.CONFIRMATION_REQUIRED) {
            return Decision.pending(Outcome.WRONG_APPROVAL_PATH, record.binding);
        }
        return authorize(record, currentArgs, currentPackage, nowMillis);
    }

    synchronized Decision reject(String requestId, long nowMillis) {
        Record record = records.get(safe(requestId));
        Decision unavailable = unavailable(record);
        if (unavailable != null) {
            return unavailable;
        }
        if (nowMillis >= record.binding.expiresAtMillis) {
            return finish(record, TerminalStatus.EXPIRED, Outcome.EXPIRED);
        }
        return finish(record, TerminalStatus.REJECTED, Outcome.REJECTED);
    }

    synchronized Decision expire(String requestId, long nowMillis) {
        Record record = records.get(safe(requestId));
        Decision unavailable = unavailable(record);
        if (unavailable != null) {
            return unavailable;
        }
        if (nowMillis < record.binding.expiresAtMillis) {
            return Decision.pending(Outcome.PENDING, record.binding);
        }
        return finish(record, TerminalStatus.EXPIRED, Outcome.EXPIRED);
    }

    synchronized Binding binding(String requestId) {
        Record record = records.get(safe(requestId));
        return record == null ? null : record.binding;
    }

    static ApprovalRequirement approvalRequirement(String tool, JSONObject args) {
        String name = safe(tool).toLowerCase(Locale.US);
        if (IMPLICIT_TOOLS.contains(name)) {
            return ApprovalRequirement.IMPLICIT;
        }
        if ("media.bookmark".equals(name)) {
            JSONObject boundedArgs = args == null ? new JSONObject() : args;
            String operation = safe(boundedArgs.optString(
                    "operation", boundedArgs.optString("action", "remember")))
                    .toLowerCase(Locale.US);
            return Set.of("list", "open", "get", "show").contains(operation)
                    ? ApprovalRequirement.IMPLICIT
                    : ApprovalRequirement.CONFIRMATION_REQUIRED;
        }
        if ("media.playlist".equals(name)) {
            JSONObject boundedArgs = args == null ? new JSONObject() : args;
            String operation = safe(boundedArgs.optString(
                    "operation",
                    boundedArgs.optString("action", "")
            )).toLowerCase(Locale.US);
            return READ_ONLY_PLAYLIST_OPERATIONS.contains(operation)
                    ? ApprovalRequirement.IMPLICIT
                    : ApprovalRequirement.CONFIRMATION_REQUIRED;
        }
        if ("screen.set_text".equals(name)) {
            return ApprovalRequirement.CONFIRMATION_REQUIRED;
        }
        return ApprovalRequirement.BLOCKED;
    }

    static String canonicalArgsDigest(JSONObject args) {
        JSONObject value = args == null ? new JSONObject() : args;
        CanonicalBudget budget = new CanonicalBudget();
        String canonical = canonicalValue(value, 0, budget);
        byte[] bytes = canonical.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_CANONICAL_ARGS_BYTES) {
            throw new IllegalArgumentException("canonical arguments exceed byte limit");
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte item : digest) {
                hex.append(String.format(Locale.US, "%02x", item & 0xff));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private Decision authorize(
            Record record,
            JSONObject currentArgs,
            String currentPackage,
            long nowMillis
    ) {
        if (nowMillis < record.binding.createdAtMillis) {
            return finish(record, TerminalStatus.STALE, Outcome.STALE);
        }
        if (nowMillis >= record.binding.expiresAtMillis) {
            return finish(record, TerminalStatus.EXPIRED, Outcome.EXPIRED);
        }
        String digest;
        try {
            digest = canonicalArgsDigest(currentArgs);
        } catch (RuntimeException malformed) {
            return finish(record, TerminalStatus.STALE, Outcome.STALE);
        }
        if (!constantTimeEquals(record.binding.argsDigest, digest)
                || !record.binding.expectedPackage.equals(safe(currentPackage))) {
            return finish(record, TerminalStatus.STALE, Outcome.STALE);
        }
        return finish(record, TerminalStatus.APPROVED, Outcome.APPROVED);
    }

    private static Decision unavailable(Record record) {
        if (record == null) {
            return Decision.missing();
        }
        if (record.terminalStatus != TerminalStatus.NONE) {
            return Decision.alreadyTerminal(record.binding, record.terminalStatus);
        }
        return null;
    }

    private static Decision finish(Record record, TerminalStatus terminal, Outcome outcome) {
        record.terminalStatus = terminal;
        return Decision.terminal(outcome, record.binding, terminal);
    }

    private static boolean constantTimeEquals(String expected, String actual) {
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.US_ASCII),
                actual.getBytes(StandardCharsets.US_ASCII)
        );
    }

    private static String canonicalValue(Object value, int depth, CanonicalBudget budget) {
        if (depth > MAX_DEPTH) {
            throw new IllegalArgumentException("arguments exceed nesting limit");
        }
        budget.consumeNode();
        if (value == null || value == JSONObject.NULL) {
            return "null";
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> iterator = object.keys();
            while (iterator.hasNext()) {
                keys.add(iterator.next());
            }
            if (keys.size() > MAX_CONTAINER_ENTRIES) {
                throw new IllegalArgumentException("argument object exceeds entry limit");
            }
            keys.sort(String::compareTo);
            StringBuilder result = new StringBuilder("{");
            for (int index = 0; index < keys.size(); index += 1) {
                String key = keys.get(index);
                requireBoundedString(key);
                if (index > 0) {
                    result.append(',');
                }
                result.append(quote(key)).append(':')
                        .append(canonicalValue(object.opt(key), depth + 1, budget));
            }
            return result.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            if (array.length() > MAX_CONTAINER_ENTRIES) {
                throw new IllegalArgumentException("argument array exceeds entry limit");
            }
            StringBuilder result = new StringBuilder("[");
            for (int index = 0; index < array.length(); index += 1) {
                if (index > 0) {
                    result.append(',');
                }
                result.append(canonicalValue(array.opt(index), depth + 1, budget));
            }
            return result.append(']').toString();
        }
        if (value instanceof String) {
            requireBoundedString((String) value);
            return quote((String) value);
        }
        if (value instanceof Boolean) {
            return value.toString();
        }
        if (value instanceof Number) {
            String raw = value.toString();
            if ("NaN".equals(raw) || "Infinity".equals(raw) || "-Infinity".equals(raw)) {
                throw new IllegalArgumentException("argument number must be finite");
            }
            try {
                BigDecimal decimal = new BigDecimal(raw).stripTrailingZeros();
                return decimal.signum() == 0 ? "0" : decimal.toPlainString();
            } catch (NumberFormatException invalid) {
                throw new IllegalArgumentException("invalid argument number", invalid);
            }
        }
        throw new IllegalArgumentException("unsupported argument value");
    }

    private static String quote(String value) {
        StringBuilder result = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index += 1) {
            char item = value.charAt(index);
            switch (item) {
                case '"': result.append("\\\""); break;
                case '\\': result.append("\\\\"); break;
                case '\b': result.append("\\b"); break;
                case '\f': result.append("\\f"); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default:
                    if (item <= 0x1f) {
                        result.append(String.format(Locale.US, "\\u%04x", (int) item));
                    } else {
                        result.append(item);
                    }
            }
        }
        return result.append('"').toString();
    }

    private static void requireBoundedString(String value) {
        if (value.length() > MAX_STRING_CHARS) {
            throw new IllegalArgumentException("argument string exceeds character limit");
        }
    }

    private static String requiredIdentifier(String value, String label) {
        String normalized = safe(value);
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException(label + " is required");
        }
        if (normalized.length() > MAX_IDENTIFIER_CHARS) {
            throw new IllegalArgumentException(label + " exceeds character limit");
        }
        return normalized;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    enum ApprovalRequirement {
        IMPLICIT,
        CONFIRMATION_REQUIRED,
        BLOCKED
    }

    enum Outcome {
        APPROVED,
        NEEDS_CONFIRMATION,
        REJECTED,
        EXPIRED,
        STALE,
        PENDING,
        ALREADY_TERMINAL,
        NOT_FOUND,
        WRONG_APPROVAL_PATH
    }

    enum TerminalStatus {
        NONE,
        APPROVED,
        REJECTED,
        EXPIRED,
        STALE
    }

    static final class Binding {
        final String requestId;
        final String tool;
        final String argsDigest;
        final String expectedPackage;
        final long createdAtMillis;
        final long expiresAtMillis;
        final ApprovalRequirement requirement;

        private Binding(
                String requestId,
                String tool,
                String argsDigest,
                String expectedPackage,
                long createdAtMillis,
                long expiresAtMillis,
                ApprovalRequirement requirement
        ) {
            this.requestId = requestId;
            this.tool = tool;
            this.argsDigest = argsDigest;
            this.expectedPackage = expectedPackage;
            this.createdAtMillis = createdAtMillis;
            this.expiresAtMillis = expiresAtMillis;
            this.requirement = requirement;
        }
    }

    static final class Decision {
        final Outcome outcome;
        final boolean mayExecute;
        final Binding binding;
        final TerminalStatus terminalStatus;

        private Decision(Outcome outcome, boolean mayExecute, Binding binding, TerminalStatus terminalStatus) {
            this.outcome = outcome;
            this.mayExecute = mayExecute;
            this.binding = binding;
            this.terminalStatus = terminalStatus;
        }

        private static Decision terminal(Outcome outcome, Binding binding, TerminalStatus terminalStatus) {
            return new Decision(outcome, outcome == Outcome.APPROVED, binding, terminalStatus);
        }

        private static Decision pending(Outcome outcome, Binding binding) {
            return new Decision(outcome, false, binding, TerminalStatus.NONE);
        }

        private static Decision alreadyTerminal(Binding binding, TerminalStatus terminalStatus) {
            return new Decision(Outcome.ALREADY_TERMINAL, false, binding, terminalStatus);
        }

        private static Decision missing() {
            return new Decision(Outcome.NOT_FOUND, false, null, TerminalStatus.NONE);
        }
    }

    private static final class Record {
        final Binding binding;
        TerminalStatus terminalStatus = TerminalStatus.NONE;

        Record(Binding binding) {
            this.binding = binding;
        }
    }

    private static final class CanonicalBudget {
        private int nodes;

        void consumeNode() {
            nodes += 1;
            if (nodes > MAX_NODES) {
                throw new IllegalArgumentException("arguments exceed node limit");
            }
        }
    }
}

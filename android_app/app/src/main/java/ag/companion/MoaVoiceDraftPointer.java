package ag.companion;

import org.json.JSONObject;

import java.util.Objects;
import java.util.regex.Pattern;

/** Android-owned durable pointer. It deliberately contains no transcript or audio. */
final class MoaVoiceDraftPointer {
    static final int MAX_AUTHORITY_TOKEN_LENGTH = 120;
    private static final Pattern AUTHORITY_TOKEN = Pattern.compile("^[A-Za-z0-9._:-]+$");

    final String draftId;
    final long revision;
    final String sessionId;
    final String branchId;

    MoaVoiceDraftPointer(String draftId, long revision, String sessionId, String branchId) {
        this.draftId = requireAuthorityToken(draftId, "draft ID");
        this.revision = revision;
        this.sessionId = requireAuthorityToken(sessionId, "session ID");
        this.branchId = requireAuthorityToken(branchId, "branch ID");
        if (!isValid()) {
            throw new IllegalArgumentException("voice draft pointer requires ID, positive revision, session, and branch");
        }
    }

    boolean isValid() {
        return isAuthorityToken(draftId)
                && revision > 0L
                && isAuthorityToken(sessionId)
                && isAuthorityToken(branchId);
    }

    JSONObject toJson() {
        JSONObject value = new JSONObject();
        try {
            value.put("id", draftId);
            value.put("revision", revision);
            value.put("session_id", sessionId);
            value.put("branch_id", branchId);
        } catch (Exception error) {
            throw new IllegalStateException("could not encode voice draft pointer", error);
        }
        return value;
    }

    static MoaVoiceDraftPointer parsePersisted(String raw) {
        if (safe(raw).isEmpty()) {
            return null;
        }
        try {
            return parsePersisted(new JSONObject(raw));
        } catch (Exception ignored) {
            return null;
        }
    }

    static MoaVoiceDraftPointer parsePersisted(JSONObject value) {
        if (value == null || value.length() != 4) {
            return null;
        }
        Object id = value.opt("id");
        Object revision = value.opt("revision");
        Object session = value.opt("session_id");
        Object branch = value.opt("branch_id");
        if (!(id instanceof String)
                || !(session instanceof String)
                || !(branch instanceof String)
                || !isIntegral(revision)) {
            return null;
        }
        long revisionValue = ((Number) revision).longValue();
        try {
            return new MoaVoiceDraftPointer((String) id, revisionValue, (String) session, (String) branch);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    static boolean isIntegral(Object value) {
        return value instanceof Byte
                || value instanceof Short
                || value instanceof Integer
                || value instanceof Long;
    }

    static boolean isAuthorityToken(String value) {
        return value != null
                && !value.isEmpty()
                && value.length() <= MAX_AUTHORITY_TOKEN_LENGTH
                && AUTHORITY_TOKEN.matcher(value).matches();
    }

    static String requireAuthorityToken(String value, String label) {
        if (!isAuthorityToken(value)) {
            throw new IllegalArgumentException(
                    label + " must match [A-Za-z0-9._:-]+ and be at most "
                            + MAX_AUTHORITY_TOKEN_LENGTH + " characters"
            );
        }
        return value;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof MoaVoiceDraftPointer)) {
            return false;
        }
        MoaVoiceDraftPointer pointer = (MoaVoiceDraftPointer) other;
        return revision == pointer.revision
                && draftId.equals(pointer.draftId)
                && sessionId.equals(pointer.sessionId)
                && branchId.equals(pointer.branchId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(draftId, revision, sessionId, branchId);
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

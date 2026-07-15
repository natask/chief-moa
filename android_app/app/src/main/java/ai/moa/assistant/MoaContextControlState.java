package ai.moa.assistant;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pure state machine for explicit conversation context controls. Incognito is
 * persistent and wins over the one-shot new-thread arm on every transport.
 */
final class MoaContextControlState {
    private static final String NOT_SAVED_SUFFIX = "\n\n(not saved)";

    private boolean newThreadArmed;
    private boolean incognitoEnabled;

    boolean toggleNewThread() {
        newThreadArmed = !newThreadArmed;
        return newThreadArmed;
    }

    void armNewThread() {
        newThreadArmed = true;
    }

    boolean toggleIncognito() {
        incognitoEnabled = !incognitoEnabled;
        return incognitoEnabled;
    }

    boolean isNewThreadArmed() {
        return newThreadArmed;
    }

    boolean isIncognitoEnabled() {
        return incognitoEnabled;
    }

    /**
     * Adds the HTTP context override. Returns true only when the one-shot new
     * thread arm was consumed, so the UI can refresh its armed presentation.
     */
    boolean applyTo(JSONObject body) throws JSONException {
        if (incognitoEnabled) {
            body.put("context_action", "incognito");
            return false;
        }
        if (!newThreadArmed) {
            return false;
        }
        body.put("context_action", "new");
        newThreadArmed = false;
        return true;
    }

    /**
     * Chooses the branch action for a streaming session. Default sessions do
     * not need a switch; a new-thread arm is consumed only when selected.
     */
    StreamingChoice consumeStreamingChoice() {
        if (incognitoEnabled) {
            return new StreamingChoice("incognito", true, false);
        }
        if (newThreadArmed) {
            newThreadArmed = false;
            return new StreamingChoice("new", false, true);
        }
        return new StreamingChoice("", false, false);
    }

    static String appendNotSaved(String text) {
        String value = safe(text);
        if (value.isEmpty() || value.endsWith(NOT_SAVED_SUFFIX)) {
            return value;
        }
        return value + NOT_SAVED_SUFFIX;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    static final class StreamingChoice {
        final String action;
        final boolean incognito;
        final boolean consumedNewThread;

        StreamingChoice(String action, boolean incognito, boolean consumedNewThread) {
            this.action = action;
            this.incognito = incognito;
            this.consumedNewThread = consumedNewThread;
        }

        boolean requiresBranchSwitch() {
            return !action.isEmpty();
        }
    }
}

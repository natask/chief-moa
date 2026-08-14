package ag.companion;

import java.util.Locale;
import java.util.UUID;

/** Retains one failed voice input below the replaceable voice transport. */
final class MoaVoiceFailureDraft {
    static final String SEND_AS_TEXT = "Send as text";
    static final String TRY_VOICE_AGAIN = "Try voice again";
    static final String RECONNECT_DEVICE = "Reconnect device";
    static final String OPEN_RELEASE_RESCUE = "Open release rescue";

    static final class Snapshot {
        final String requestId;
        final String text;
        final boolean authenticationFailure;

        Snapshot(String requestId, String text, boolean authenticationFailure) {
            this.requestId = requestId;
            this.text = text;
            this.authenticationFailure = authenticationFailure;
        }
    }

    private String requestId = "";
    private String bestTranscript = "";
    private boolean authenticationFailure;
    private boolean failed;
    private String pendingTextIdentity = "";

    void begin(String turnId) {
        String identity = clean(turnId);
        if (!identity.isEmpty() && identity.equals(requestId)) {
            failed = false;
            return;
        }
        requestId = identity.isEmpty() ? newIdentity() : identity;
        bestTranscript = "";
        authenticationFailure = false;
        failed = false;
    }

    void observe(String transcript) {
        String value = clean(transcript);
        if (!value.isEmpty()) bestTranscript = value;
    }

    Snapshot fail(String turnId, String transcript, String diagnostic) {
        String identity = clean(turnId);
        if (!identity.isEmpty() && !identity.equals(requestId)) begin(identity);
        if (requestId.isEmpty()) requestId = newIdentity();
        observe(transcript);
        authenticationFailure = isAuthenticationFailure(diagnostic);
        failed = true;
        return snapshot();
    }

    Snapshot snapshot() {
        return new Snapshot(requestId, bestTranscript, authenticationFailure);
    }

    boolean hasFailedDraft() {
        return failed && !bestTranscript.isEmpty() && !requestId.isEmpty();
    }

    void armTextSubmit(String identity) {
        pendingTextIdentity = clean(identity);
    }

    String nextTextTurnId() {
        String identity = pendingTextIdentity;
        pendingTextIdentity = "";
        return identity.isEmpty() ? newIdentity() : identity;
    }

    static boolean isAuthenticationFailure(String diagnostic) {
        String value = clean(diagnostic).toLowerCase(Locale.US);
        return value.contains("token")
                || value.contains("unauthor")
                || value.contains("forbidden")
                || value.contains("401")
                || value.contains("403")
                || value.contains("credential")
                || value.contains("enrollment")
                || value.contains("re-pair")
                || value.contains("reconnect device");
    }

    static boolean isRecoverableTransportFailure(String diagnostic) {
        String value = clean(diagnostic).toLowerCase(Locale.US);
        return value.contains("gemini-live generation was interrupted")
                || value.contains("failed to complete turn: gemini-live");
    }

    static String shortNotice(String diagnostic) {
        String value = clean(diagnostic).toLowerCase(Locale.US);
        if (value.contains("token was rejected") || value.contains("token required")) {
            return "Voice can't connect: the gateway rejected this device's token. Re-pair in the Ag app.";
        }
        if (value.contains("url issue") || value.contains("not deployed")
                || value.contains("could not resolve")) {
            return "Voice can't connect. Check the gateway URL in the Ag app.";
        }
        return "Voice failed.";
    }

    private static String newIdentity() {
        return "turn_" + UUID.randomUUID().toString();
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}

package ai.moa.assistant;

final class MoaVoiceSessionTermination {
    enum Kind { LOCAL_CANCEL, REMOTE_CLOSE }

    final Kind kind;
    final int code;
    final String reason;

    private MoaVoiceSessionTermination(Kind kind, int code, String reason) {
        this.kind = kind;
        this.code = code;
        this.reason = reason == null ? "" : reason;
    }

    static MoaVoiceSessionTermination localCancel() {
        return new MoaVoiceSessionTermination(Kind.LOCAL_CANCEL, 1000, "local cancel");
    }

    static MoaVoiceSessionTermination remoteClose(int code, String reason) {
        return new MoaVoiceSessionTermination(Kind.REMOTE_CLOSE, code, reason);
    }
}

package ag.companion;

import java.util.Locale;

/** Pure fail-closed admission decision used before any draft socket is opened. */
final class MoaVoiceDraftAdmission {
    enum Mode {
        DRAFT,
        LEGACY,
        BLOCKED
    }

    final Mode mode;
    final String contextAction;
    final String sessionId;
    final String branchId;
    final MoaVoiceDraftPointer resumePointer;

    private MoaVoiceDraftAdmission(
            Mode mode,
            String contextAction,
            String sessionId,
            String branchId,
            MoaVoiceDraftPointer resumePointer
    ) {
        this.mode = mode;
        this.contextAction = contextAction;
        this.sessionId = sessionId;
        this.branchId = branchId;
        this.resumePointer = resumePointer;
    }

    static MoaVoiceDraftAdmission decide(
            boolean capabilitySupported,
            String requestedContextAction,
            String sessionId,
            String resolvedBranchId,
            MoaVoiceDraftPointer resumePointer
    ) {
        if (!capabilitySupported) {
            return new MoaVoiceDraftAdmission(Mode.LEGACY, "continue", "", "", null);
        }
        String action = normalizeAction(requestedContextAction);
        if (action.isEmpty()) {
            return blocked();
        }
        if (resumePointer != null) {
            if (!"continue".equals(action)) {
                return blocked();
            }
            return new MoaVoiceDraftAdmission(
                    Mode.DRAFT,
                    action,
                    resumePointer.sessionId,
                    resumePointer.branchId,
                    resumePointer
            );
        }
        if (!MoaVoiceDraftPointer.isAuthorityToken(sessionId)
                || !MoaVoiceDraftPointer.isAuthorityToken(resolvedBranchId)) {
            return blocked();
        }
        return new MoaVoiceDraftAdmission(Mode.DRAFT, action, sessionId, resolvedBranchId, null);
    }

    static boolean requiresResolvedBranch(String requestedContextAction) {
        String action = normalizeAction(requestedContextAction);
        return "new".equals(action) || "fork".equals(action) || "incognito".equals(action);
    }

    private static MoaVoiceDraftAdmission blocked() {
        return new MoaVoiceDraftAdmission(Mode.BLOCKED, "", "", "", null);
    }

    private static String normalizeAction(String value) {
        String action = safe(value).toLowerCase(Locale.US);
        if (action.isEmpty()) {
            return "continue";
        }
        switch (action) {
            case "continue":
            case "new":
            case "fork":
            case "incognito":
                return action;
            default:
                return "";
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

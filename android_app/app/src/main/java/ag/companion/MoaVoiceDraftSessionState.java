package ag.companion;

import org.json.JSONObject;

/**
 * Pure authority, revision, delivery, and cancellation gate for one draft
 * WebSocket session. Network, timer, and microphone effects live in the
 * controller; this class makes their race-sensitive decisions atomic.
 */
final class MoaVoiceDraftSessionState {
    enum Action {
        PAUSE("pause", "paused"),
        PARK("park", "parked"),
        DISCARD("discard", "discarded");

        final String wireName;
        final String acknowledgedState;

        Action(String wireName, String acknowledgedState) {
            this.wireName = wireName;
            this.acknowledgedState = acknowledgedState;
        }

        static Action fromWireName(String value) {
            for (Action action : values()) {
                if (action.wireName.equals(value)) {
                    return action;
                }
            }
            return null;
        }
    }

    static final class ControlRequest {
        final Action action;
        final String idempotencyKey;
        final MoaVoiceDraftPointer authority;

        ControlRequest(Action action, String idempotencyKey, MoaVoiceDraftPointer authority) {
            this.action = action;
            this.idempotencyKey = idempotencyKey;
            this.authority = authority;
        }
    }

    static final class ControlAck {
        final Action action;
        final MoaVoiceDraftPointer authority;
        final Action queuedAction;

        ControlAck(Action action, MoaVoiceDraftPointer authority, Action queuedAction) {
            this.action = action;
            this.authority = authority;
            this.queuedAction = queuedAction;
        }
    }

    static final class TerminalReceipt {
        final MoaVoiceDraftPointer authority;
        final String state;

        TerminalReceipt(MoaVoiceDraftPointer authority, String state) {
            this.authority = authority;
            this.state = state;
        }
    }

    private final String sessionId;
    private final String branchId;
    private final String turnId;
    private final MoaVoiceDraftPointer requestedResume;
    private MoaVoiceDraftPointer authority;
    private PendingControl pendingControl;
    private PendingControl queuedTerminalDiscard;
    private boolean terminalCancellationLatched;
    private boolean transportReady;
    private boolean commitRequested;
    private boolean commitReserved;

    MoaVoiceDraftSessionState(
            String sessionId,
            String branchId,
            String turnId,
            MoaVoiceDraftPointer requestedResume
    ) {
        this.sessionId = MoaVoiceDraftPointer.requireAuthorityToken(sessionId, "session ID");
        this.branchId = MoaVoiceDraftPointer.requireAuthorityToken(branchId, "branch ID");
        this.turnId = MoaVoiceDraftPointer.requireAuthorityToken(turnId, "turn ID");
        this.requestedResume = requestedResume;
        if (requestedResume != null
                && (!this.sessionId.equals(requestedResume.sessionId)
                || !this.branchId.equals(requestedResume.branchId))) {
            throw new IllegalArgumentException("resume pointer authority does not match draft session_start");
        }
    }

    synchronized boolean isResume() {
        return requestedResume != null;
    }

    synchronized boolean isReady() {
        return authority != null;
    }

    synchronized boolean isAwaitingReadyAck() {
        return authority == null;
    }

    synchronized boolean isAwaitingControlAck() {
        return pendingControl != null && pendingControl.sent;
    }

    synchronized boolean isTerminalCancellationLatched() {
        return terminalCancellationLatched;
    }

    synchronized MoaVoiceDraftPointer authority() {
        return authority;
    }

    synchronized boolean hasPendingControl() {
        return pendingControl != null;
    }

    synchronized Action pendingAction() {
        return pendingControl == null ? null : pendingControl.action;
    }

    synchronized boolean requestControl(Action action, String idempotencyKey) {
        if (action == null || !MoaVoiceDraftPointer.isAuthorityToken(idempotencyKey)) {
            return false;
        }
        if (action == Action.DISCARD) {
            if (commitReserved) {
                return false;
            }
            terminalCancellationLatched = true;
            commitRequested = false;
            if (pendingControl == null) {
                pendingControl = new PendingControl(action, idempotencyKey);
                return true;
            }
            if (pendingControl.action == Action.DISCARD || queuedTerminalDiscard != null) {
                return true;
            }
            if (!pendingControl.sent) {
                pendingControl = new PendingControl(action, idempotencyKey);
            } else {
                queuedTerminalDiscard = new PendingControl(action, idempotencyKey);
            }
            return true;
        }
        if (terminalCancellationLatched || commitRequested || commitReserved) {
            return false;
        }
        if (pendingControl == null) {
            pendingControl = new PendingControl(action, idempotencyKey);
            return true;
        }
        return pendingControl.action == action;
    }

    /** Reserve ACK admission before the WebSocket enqueue can synchronously race it. */
    synchronized ControlRequest reserveControlToSend() {
        if (authority == null || pendingControl == null || pendingControl.sent) {
            return null;
        }
        pendingControl.sent = true;
        return new ControlRequest(pendingControl.action, pendingControl.idempotencyKey, authority);
    }

    synchronized void rollbackControlReservation(Action action, String idempotencyKey) {
        if (pendingControl != null
                && pendingControl.sent
                && pendingControl.action == action
                && pendingControl.idempotencyKey.equals(idempotencyKey)) {
            pendingControl.sent = false;
        }
    }

    synchronized boolean requestCommit() {
        if (terminalCancellationLatched || pendingControl != null || commitReserved) {
            return false;
        }
        commitRequested = true;
        return true;
    }

    synchronized boolean markTransportReady() {
        transportReady = true;
        return canReserveCommitLocked();
    }

    synchronized MoaVoiceDraftPointer reserveCommitAuthority() {
        if (!canReserveCommitLocked()) {
            return null;
        }
        commitReserved = true;
        commitRequested = false;
        return authority;
    }

    private boolean canReserveCommitLocked() {
        return authority != null
                && transportReady
                && commitRequested
                && !commitReserved
                && !terminalCancellationLatched
                && pendingControl == null;
    }

    synchronized boolean bindReady(JSONObject event) {
        if (authority != null
                || event == null
                || hasForbiddenAuthorityAlias(event)
                || !"voice_draft_ready".equals(exactString(event, "type"))) {
            return false;
        }
        String expectedAction = requestedResume == null ? "create" : "resume";
        if (!expectedAction.equals(exactString(event, "action"))
                || !sessionId.equals(exactString(event, "session_id"))
                || !branchId.equals(exactString(event, "branch_id"))
                || !turnId.equals(exactString(event, "turn_id"))) {
            return false;
        }
        DraftReceipt receipt = parseReceipt(event.optJSONObject("draft"));
        if (receipt == null
                || !"capturing".equals(receipt.state)
                || !sessionId.equals(receipt.pointer.sessionId)
                || !branchId.equals(receipt.pointer.branchId)) {
            return false;
        }
        if (requestedResume != null
                && (!requestedResume.draftId.equals(receipt.pointer.draftId)
                || receipt.pointer.revision <= requestedResume.revision)) {
            return false;
        }
        authority = receipt.pointer;
        return true;
    }

    synchronized ControlAck acceptControlAck(JSONObject event) {
        if (authority == null
                || pendingControl == null
                || !pendingControl.sent
                || event == null
                || hasForbiddenAuthorityAlias(event)
                || !"voice_draft_control_ack".equals(exactString(event, "type"))) {
            return null;
        }
        Action action = Action.fromWireName(exactString(event, "action"));
        if (action != pendingControl.action
                || !sessionId.equals(exactString(event, "session_id"))
                || !branchId.equals(exactString(event, "branch_id"))
                || !turnId.equals(exactString(event, "turn_id"))) {
            return null;
        }
        DraftReceipt receipt = parseReceipt(event.optJSONObject("draft"));
        if (receipt == null
                || !action.acknowledgedState.equals(receipt.state)
                || !authority.draftId.equals(receipt.pointer.draftId)
                || !sessionId.equals(receipt.pointer.sessionId)
                || !branchId.equals(receipt.pointer.branchId)
                || receipt.pointer.revision <= authority.revision) {
            return null;
        }
        authority = receipt.pointer;
        pendingControl = null;
        if (action != Action.DISCARD && queuedTerminalDiscard != null) {
            pendingControl = queuedTerminalDiscard;
            queuedTerminalDiscard = null;
        }
        return new ControlAck(action, authority, pendingAction());
    }

    synchronized TerminalReceipt acceptTerminalReceipt(JSONObject event) {
        if (authority == null
                || event == null
                || hasForbiddenAuthorityAlias(event)
                || !"turn_done".equals(exactString(event, "type"))
                || !sessionId.equals(exactString(event, "session_id"))
                || !branchId.equals(exactString(event, "branch_id"))
                || !turnId.equals(exactString(event, "turn_id"))) {
            return null;
        }
        DraftReceipt receipt = parseReceipt(event.optJSONObject("draft"));
        if (receipt == null
                || !("sent".equals(receipt.state) || "discarded".equals(receipt.state))
                || ("sent".equals(receipt.state) && !commitReserved)
                || ("discarded".equals(receipt.state) && !terminalCancellationLatched)
                || !authority.draftId.equals(receipt.pointer.draftId)
                || !sessionId.equals(receipt.pointer.sessionId)
                || !branchId.equals(receipt.pointer.branchId)
                || receipt.pointer.revision <= authority.revision) {
            return null;
        }
        authority = receipt.pointer;
        pendingControl = null;
        queuedTerminalDiscard = null;
        commitRequested = false;
        commitReserved = false;
        return new TerminalReceipt(authority, receipt.state);
    }

    private static DraftReceipt parseReceipt(JSONObject draft) {
        if (draft == null || hasForbiddenAuthorityAlias(draft)) {
            return null;
        }
        Object id = draft.opt("id");
        Object revision = draft.opt("revision");
        Object session = draft.opt("session_id");
        Object branch = draft.opt("branch_id");
        Object state = draft.opt("state");
        if (!(id instanceof String)
                || !MoaVoiceDraftPointer.isIntegral(revision)
                || !(session instanceof String)
                || !(branch instanceof String)
                || !(state instanceof String)) {
            return null;
        }
        try {
            MoaVoiceDraftPointer pointer = new MoaVoiceDraftPointer(
                    (String) id,
                    ((Number) revision).longValue(),
                    (String) session,
                    (String) branch
            );
            return new DraftReceipt(pointer, (String) state);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    private static String exactString(JSONObject value, String key) {
        Object candidate = value == null ? null : value.opt(key);
        return candidate instanceof String ? (String) candidate : "";
    }

    private static boolean hasForbiddenAuthorityAlias(JSONObject value) {
        if (value == null) {
            return false;
        }
        String[] aliases = {
                "conversation_id",
                "sessionId",
                "branchId",
                "turnId",
                "draft_id",
                "voice_draft_session_id",
                "voice_draft_branch_id",
                "voice_draft_revision"
        };
        for (String alias : aliases) {
            if (value.has(alias)) {
                return true;
            }
        }
        return false;
    }

    private static final class PendingControl {
        final Action action;
        final String idempotencyKey;
        boolean sent;

        PendingControl(Action action, String idempotencyKey) {
            this.action = action;
            this.idempotencyKey = idempotencyKey;
        }
    }

    private static final class DraftReceipt {
        final MoaVoiceDraftPointer pointer;
        final String state;

        DraftReceipt(MoaVoiceDraftPointer pointer, String state) {
            this.pointer = pointer;
            this.state = state;
        }
    }
}

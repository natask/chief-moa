package ai.moa.assistant;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Pure Android-local authority for one reviewable draft insertion.
 *
 * <p>A server or screen observation may supply proposed text, but only the local surface can
 * create the explicit approval and invoke the effect. The exact text never becomes a click,
 * editor action, or submit action.</p>
 */
final class MoaDraftInsertionPolicy {
    static final long MAX_PROPOSAL_AGE_MS = 30_000L;
    static final long MAX_TARGET_AGE_MS = 5_000L;
    static final int MAX_TEXT_CHARS = 16_000;

    enum Kind {
        INSERT_TEXT,
        SEND
    }

    enum EffectPath {
        IME_COMMIT_TEXT
    }

    enum Status {
        EXECUTED,
        REFUSED,
        FAILED
    }

    enum Reason {
        NONE,
        INVALID_PROPOSAL,
        NO_ACTIVE_EDITOR,
        NO_CANDIDATE,
        EMPTY_TEXT,
        TEXT_TOO_LARGE,
        SEND_UNSUPPORTED,
        MISSING_APPROVAL,
        APPROVAL_MISMATCH,
        EXPIRED_PROPOSAL,
        STALE_TARGET,
        PACKAGE_MISMATCH,
        TARGET_MISMATCH,
        SENSITIVE_TARGET,
        UNSUPPORTED_TARGET,
        REPLAYED,
        EFFECT_FAILED
    }

    interface InsertionEffect {
        boolean insertExactText(String exactText);
    }

    static final class EditableTarget {
        final String packageName;
        final String semanticId;
        final String role;
        final String fingerprint;
        final long observedAtMs;
        final boolean ordinaryEditable;

        private EditableTarget(
                String packageName,
                String semanticId,
                String role,
                String fingerprint,
                long observedAtMs,
                boolean ordinaryEditable
        ) {
            this.packageName = safe(packageName);
            this.semanticId = safe(semanticId);
            this.role = safe(role);
            this.fingerprint = safe(fingerprint);
            this.observedAtMs = observedAtMs;
            this.ordinaryEditable = ordinaryEditable;
        }

        static EditableTarget fromEditor(
                MoaEditorSensitivityPolicy.EditorIdentity editor,
                long observedAtMs
        ) {
            if (editor == null) {
                return new EditableTarget("", "", "", "", observedAtMs, false);
            }
            String semanticId = editor.fieldName.isEmpty()
                    ? "field:" + editor.fieldId
                    : editor.fieldName;
            String role = "input:" + (editor.inputType & 0x0f);
            String canonical = editor.packageName + "\n"
                    + editor.fieldId + "\n"
                    + editor.inputType + "\n"
                    + editor.imeOptions + "\n"
                    + editor.fieldName + "\n"
                    + editor.hintText + "\n"
                    + editor.privateImeOptions;
            return new EditableTarget(
                    editor.packageName,
                    semanticId,
                    role,
                    sha256(canonical),
                    observedAtMs,
                    MoaEditorSensitivityPolicy.classify(editor)
                            == MoaEditorSensitivityPolicy.Classification.ORDINARY
            );
        }
    }

    static final class Proposal {
        final String proposalId;
        final Kind kind;
        final String exactText;
        final String expectedPackage;
        final String targetFingerprint;
        final long createdAtMs;
        final String digest;

        private Proposal(
                String proposalId,
                Kind kind,
                String exactText,
                String expectedPackage,
                String targetFingerprint,
                long createdAtMs
        ) {
            this.proposalId = safe(proposalId);
            this.kind = kind;
            this.exactText = exactText == null ? "" : exactText;
            this.expectedPackage = safe(expectedPackage);
            this.targetFingerprint = safe(targetFingerprint);
            this.createdAtMs = createdAtMs;
            this.digest = sha256(this.proposalId + "\n"
                    + kind.name() + "\n"
                    + this.exactText + "\n"
                    + this.expectedPackage + "\n"
                    + this.targetFingerprint + "\n"
                    + createdAtMs);
        }

        static Proposal insert(String proposalId, String exactText, EditableTarget target, long createdAtMs) {
            return new Proposal(
                    proposalId,
                    Kind.INSERT_TEXT,
                    exactText,
                    target == null ? "" : target.packageName,
                    target == null ? "" : target.fingerprint,
                    createdAtMs
            );
        }

        static Proposal send(String proposalId, EditableTarget target, long createdAtMs) {
            return new Proposal(
                    proposalId,
                    Kind.SEND,
                    "",
                    target == null ? "" : target.packageName,
                    target == null ? "" : target.fingerprint,
                    createdAtMs
            );
        }
    }

    static final class Approval {
        final String proposalId;
        final String proposalDigest;
        final long approvedAtMs;

        private Approval(String proposalId, String proposalDigest, long approvedAtMs) {
            this.proposalId = safe(proposalId);
            this.proposalDigest = safe(proposalDigest);
            this.approvedAtMs = approvedAtMs;
        }

        /** Called only from a visible local approval control. */
        static Approval explicitLocal(Proposal proposal, long approvedAtMs) {
            return new Approval(
                    proposal == null ? "" : proposal.proposalId,
                    proposal == null ? "" : proposal.digest,
                    approvedAtMs
            );
        }
    }

    static final class Receipt {
        final String proposalId;
        final Status status;
        final Reason reason;
        final String targetPackage;
        final String targetFingerprint;
        final String proposedTextSha256;
        final EffectPath effectPath;
        final boolean explicitApproval;

        private Receipt(
                Proposal proposal,
                Status status,
                Reason reason,
                EditableTarget target,
                boolean explicitApproval
        ) {
            this.proposalId = proposal == null ? "" : proposal.proposalId;
            this.status = status;
            this.reason = reason;
            this.targetPackage = proposal != null && !proposal.expectedPackage.isEmpty()
                    ? proposal.expectedPackage
                    : target == null ? "" : target.packageName;
            this.targetFingerprint = proposal != null && !proposal.targetFingerprint.isEmpty()
                    ? proposal.targetFingerprint
                    : target == null ? "" : target.fingerprint;
            this.proposedTextSha256 = proposal == null ? "" : sha256(proposal.exactText);
            this.effectPath = EffectPath.IME_COMMIT_TEXT;
            this.explicitApproval = explicitApproval;
        }

        boolean succeeded() {
            return status == Status.EXECUTED;
        }
    }

    static final class Controller {
        private final Set<String> terminalProposalIds = new HashSet<>();

        Receipt execute(
                Proposal proposal,
                Approval approval,
                EditableTarget finalTarget,
                long nowMs,
                InsertionEffect effect
        ) {
            Reason refusal = authorize(proposal, approval, finalTarget, nowMs);
            boolean explicitlyApproved = approval != null;
            if (refusal != Reason.NONE) {
                if (proposal != null && !proposal.proposalId.isEmpty()) {
                    terminalProposalIds.add(proposal.proposalId);
                }
                return new Receipt(proposal, Status.REFUSED, refusal, finalTarget, explicitlyApproved);
            }
            if (terminalProposalIds.contains(proposal.proposalId)) {
                return new Receipt(proposal, Status.REFUSED, Reason.REPLAYED, finalTarget, true);
            }
            // Mark terminal before invoking the platform. A failed editor call is not retried and
            // can never turn one approval into two mutations.
            terminalProposalIds.add(proposal.proposalId);
            boolean inserted = effect != null && effect.insertExactText(proposal.exactText);
            return new Receipt(
                    proposal,
                    inserted ? Status.EXECUTED : Status.FAILED,
                    inserted ? Reason.NONE : Reason.EFFECT_FAILED,
                    finalTarget,
                    true
            );
        }

        Receipt refuseTerminal(
                Proposal proposal,
                Approval approval,
                EditableTarget finalTarget,
                Reason reason
        ) {
            boolean explicitlyApproved = approval != null;
            if (proposal != null && !proposal.proposalId.isEmpty()
                    && terminalProposalIds.contains(proposal.proposalId)) {
                return new Receipt(proposal, Status.REFUSED, Reason.REPLAYED, finalTarget,
                        explicitlyApproved);
            }
            if (proposal != null && !proposal.proposalId.isEmpty()) {
                terminalProposalIds.add(proposal.proposalId);
            }
            Reason terminalReason = reason == null || reason == Reason.NONE
                    ? Reason.INVALID_PROPOSAL
                    : reason;
            return new Receipt(proposal, Status.REFUSED, terminalReason, finalTarget,
                    explicitlyApproved);
        }
    }

    private MoaDraftInsertionPolicy() {
    }

    static Reason authorize(
            Proposal proposal,
            Approval approval,
            EditableTarget finalTarget,
            long nowMs
    ) {
        if (proposal == null
                || proposal.proposalId.isEmpty()
                || proposal.expectedPackage.isEmpty()) {
            return Reason.INVALID_PROPOSAL;
        }
        if (proposal.kind == Kind.SEND) {
            return Reason.SEND_UNSUPPORTED;
        }
        if (proposal.exactText.isEmpty()) {
            return Reason.EMPTY_TEXT;
        }
        if (proposal.exactText.length() > MAX_TEXT_CHARS) {
            return Reason.TEXT_TOO_LARGE;
        }
        if (approval == null) {
            return Reason.MISSING_APPROVAL;
        }
        if (!proposal.proposalId.equals(approval.proposalId)
                || !proposal.digest.equals(approval.proposalDigest)) {
            return Reason.APPROVAL_MISMATCH;
        }
        if (nowMs < proposal.createdAtMs
                || nowMs - proposal.createdAtMs > MAX_PROPOSAL_AGE_MS
                || approval.approvedAtMs < proposal.createdAtMs
                || approval.approvedAtMs > nowMs) {
            return Reason.EXPIRED_PROPOSAL;
        }
        if (finalTarget == null) {
            return Reason.UNSUPPORTED_TARGET;
        }
        if (nowMs < finalTarget.observedAtMs
                || nowMs - finalTarget.observedAtMs > MAX_TARGET_AGE_MS) {
            return Reason.STALE_TARGET;
        }
        if (!proposal.expectedPackage.equals(finalTarget.packageName)) {
            return Reason.PACKAGE_MISMATCH;
        }
        if (!proposal.targetFingerprint.equals(finalTarget.fingerprint)) {
            return Reason.TARGET_MISMATCH;
        }
        if (!finalTarget.ordinaryEditable) {
            return Reason.SENSITIVE_TARGET;
        }
        return Reason.NONE;
    }

    static String reasonMessage(Reason reason) {
        if (reason == null) {
            return "Insertion refused";
        }
        switch (reason) {
            case NONE:
                return "Inserted exactly; nothing was submitted";
            case SEND_UNSUPPORTED:
                return "Send is a separate unsupported action; nothing was submitted";
            case EXPIRED_PROPOSAL:
            case STALE_TARGET:
                return "Draft or editor is stale; review it again";
            case PACKAGE_MISMATCH:
            case TARGET_MISMATCH:
                return "Editor changed; draft was not inserted";
            case SENSITIVE_TARGET:
                return "Sensitive editor: insertion blocked";
            case NO_ACTIVE_EDITOR:
                return "No active editor; draft was not inserted";
            case NO_CANDIDATE:
                return "No candidate staged; nothing was inserted";
            case EFFECT_FAILED:
                return "Editor refused insertion";
            case REPLAYED:
                return "Draft approval was already consumed";
            default:
                return "Insertion refused";
        }
    }

    private static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            }
            return hex.toString();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}

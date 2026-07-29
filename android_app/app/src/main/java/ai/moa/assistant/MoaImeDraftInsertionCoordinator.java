package ai.moa.assistant;

/** Testable service path from one visible IME Insert press to one terminal receipt. */
final class MoaImeDraftInsertionCoordinator {
    private final MoaEditorSessionBinding binding;
    private final MoaDraftInsertionPolicy.Controller controller;

    MoaImeDraftInsertionCoordinator(
            MoaEditorSessionBinding binding,
            MoaDraftInsertionPolicy.Controller controller
    ) {
        this.binding = binding;
        this.controller = controller;
    }

    MoaDraftInsertionPolicy.Receipt attemptInsert(
            String proposalId,
            MoaEditorSessionBinding.SessionToken session,
            MoaEditorSensitivityPolicy.EditorIdentity observedEditor,
            long nowMs,
            MoaDraftInsertionPolicy.InsertionEffect effect
    ) {
        MoaEditorSensitivityPolicy.EditorIdentity boundEditor = session == null
                ? null
                : session.editor;
        String stagedText = binding.stagedCandidateForAttempt(session);
        MoaDraftInsertionPolicy.EditableTarget boundTarget =
                MoaDraftInsertionPolicy.EditableTarget.fromEditor(boundEditor, nowMs);
        MoaDraftInsertionPolicy.Proposal proposal = MoaDraftInsertionPolicy.Proposal.insert(
                proposalId,
                stagedText,
                boundTarget,
                nowMs
        );
        MoaDraftInsertionPolicy.Approval approval =
                MoaDraftInsertionPolicy.Approval.explicitLocal(proposal, nowMs);
        MoaDraftInsertionPolicy.EditableTarget finalTarget =
                MoaDraftInsertionPolicy.EditableTarget.fromEditor(observedEditor, nowMs);

        MoaEditorSessionBinding.CommitDecision bindingDecision =
                binding.authorizeCommit(session, observedEditor);
        if (!bindingDecision.allowed) {
            return controller.refuseTerminal(
                    proposal,
                    approval,
                    finalTarget,
                    policyReason(bindingDecision.rejection)
            );
        }
        return controller.execute(proposal, approval, finalTarget, nowMs, effect);
    }

    private static MoaDraftInsertionPolicy.Reason policyReason(
            MoaEditorSessionBinding.Rejection rejection
    ) {
        if (rejection == null) {
            return MoaDraftInsertionPolicy.Reason.INVALID_PROPOSAL;
        }
        switch (rejection) {
            case NO_ACTIVE_EDITOR:
                return MoaDraftInsertionPolicy.Reason.NO_ACTIVE_EDITOR;
            case SENSITIVE_EDITOR:
                return MoaDraftInsertionPolicy.Reason.SENSITIVE_TARGET;
            case STALE_EDITOR:
                return MoaDraftInsertionPolicy.Reason.TARGET_MISMATCH;
            case NO_CANDIDATE:
                return MoaDraftInsertionPolicy.Reason.NO_CANDIDATE;
            case EMPTY_CANDIDATE:
                return MoaDraftInsertionPolicy.Reason.EMPTY_TEXT;
            default:
                return MoaDraftInsertionPolicy.Reason.INVALID_PROPOSAL;
        }
    }
}

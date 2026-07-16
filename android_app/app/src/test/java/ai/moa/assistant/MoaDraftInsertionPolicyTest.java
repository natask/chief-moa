package ai.moa.assistant;

import android.text.InputType;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public final class MoaDraftInsertionPolicyTest {
    private static final long NOW = 1_000_000L;

    @Test
    public void explicitApprovalInsertsExactTextOnceAndReceiptsBoundTarget() {
        MoaDraftInsertionPolicy.EditableTarget target = target(editor("pkg", 7, "body"), NOW);
        MoaDraftInsertionPolicy.Proposal proposal = MoaDraftInsertionPolicy.Proposal.insert(
                "proposal-1", "  Exact screen-aware draft.  ", target, NOW);
        MoaDraftInsertionPolicy.Approval approval =
                MoaDraftInsertionPolicy.Approval.explicitLocal(proposal, NOW);
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<String> inserted = new AtomicReference<>();
        MoaDraftInsertionPolicy.Controller controller = new MoaDraftInsertionPolicy.Controller();

        MoaDraftInsertionPolicy.Receipt receipt = controller.execute(
                proposal,
                approval,
                target,
                NOW,
                exactText -> {
                    calls.incrementAndGet();
                    inserted.set(exactText);
                    return true;
                }
        );

        assertTrue(receipt.succeeded());
        assertEquals(MoaDraftInsertionPolicy.Status.EXECUTED, receipt.status);
        assertEquals(MoaDraftInsertionPolicy.Reason.NONE, receipt.reason);
        assertEquals("  Exact screen-aware draft.  ", inserted.get());
        assertEquals(1, calls.get());
        assertEquals("proposal-1", receipt.proposalId);
        assertEquals("pkg", receipt.targetPackage);
        assertEquals(target.fingerprint, receipt.targetFingerprint);
        assertEquals(MoaDraftInsertionPolicy.EffectPath.IME_COMMIT_TEXT, receipt.effectPath);
        assertTrue(receipt.explicitApproval);
        assertFalse(receipt.proposedTextSha256.contains("Exact"));
        assertEquals(64, receipt.proposedTextSha256.length());

        MoaDraftInsertionPolicy.Receipt replay = controller.execute(
                proposal, approval, target, NOW, exactText -> {
                    calls.incrementAndGet();
                    return true;
                });
        assertEquals(MoaDraftInsertionPolicy.Status.REFUSED, replay.status);
        assertEquals(MoaDraftInsertionPolicy.Reason.REPLAYED, replay.reason);
        assertEquals(1, calls.get());
    }

    @Test
    public void proposalAndTargetFingerprintBindAllSemanticEditorIdentity() {
        MoaDraftInsertionPolicy.EditableTarget first = target(editor("pkg", 7, "body"), NOW);
        MoaDraftInsertionPolicy.EditableTarget same = target(editor("pkg", 7, "body"), NOW + 1);
        MoaDraftInsertionPolicy.EditableTarget changedId = target(editor("pkg", 8, "body"), NOW);
        MoaDraftInsertionPolicy.EditableTarget changedName = target(editor("pkg", 7, "subject"), NOW);

        assertEquals("body", first.semanticId);
        assertEquals("input:1", first.role);
        assertTrue(first.ordinaryEditable);
        assertEquals(first.fingerprint, same.fingerprint);
        assertNotEquals(first.fingerprint, changedId.fingerprint);
        assertNotEquals(first.fingerprint, changedName.fingerprint);
        assertEquals("field:7", target(editor("pkg", 7, ""), NOW).semanticId);
        assertFalse(MoaDraftInsertionPolicy.EditableTarget.fromEditor(null, NOW).ordinaryEditable);

        MoaDraftInsertionPolicy.Proposal firstProposal = MoaDraftInsertionPolicy.Proposal.insert(
                "proposal", "text", first, NOW);
        MoaDraftInsertionPolicy.Proposal changedText = MoaDraftInsertionPolicy.Proposal.insert(
                "proposal", "other", first, NOW);
        assertNotEquals(firstProposal.digest, changedText.digest);
    }

    @Test
    public void everyApprovalAndFreshnessInvariantFailsBeforeEffect() {
        MoaDraftInsertionPolicy.EditableTarget target = target(editor("pkg", 7, "body"), NOW);
        MoaDraftInsertionPolicy.Proposal proposal = MoaDraftInsertionPolicy.Proposal.insert(
                "proposal", "text", target, NOW);
        MoaDraftInsertionPolicy.Approval approval =
                MoaDraftInsertionPolicy.Approval.explicitLocal(proposal, NOW);

        assertReason(MoaDraftInsertionPolicy.Reason.MISSING_APPROVAL, proposal, null, target, NOW);

        MoaDraftInsertionPolicy.Proposal other = MoaDraftInsertionPolicy.Proposal.insert(
                "other", "text", target, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.APPROVAL_MISMATCH,
                proposal,
                MoaDraftInsertionPolicy.Approval.explicitLocal(other, NOW),
                target,
                NOW
        );
        MoaDraftInsertionPolicy.Proposal sameIdDifferentText = MoaDraftInsertionPolicy.Proposal.insert(
                "proposal", "changed", target, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.APPROVAL_MISMATCH,
                proposal,
                MoaDraftInsertionPolicy.Approval.explicitLocal(sameIdDifferentText, NOW),
                target,
                NOW
        );
        assertReason(MoaDraftInsertionPolicy.Reason.EXPIRED_PROPOSAL, proposal, approval, target, NOW - 1);
        assertReason(
                MoaDraftInsertionPolicy.Reason.EXPIRED_PROPOSAL,
                proposal,
                approval,
                target,
                NOW + MoaDraftInsertionPolicy.MAX_PROPOSAL_AGE_MS + 1
        );

        MoaDraftInsertionPolicy.Proposal futureApprovalProposal = MoaDraftInsertionPolicy.Proposal.insert(
                "future-approval", "text", target, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.EXPIRED_PROPOSAL,
                futureApprovalProposal,
                MoaDraftInsertionPolicy.Approval.explicitLocal(futureApprovalProposal, NOW - 1),
                target,
                NOW
        );
        assertReason(
                MoaDraftInsertionPolicy.Reason.EXPIRED_PROPOSAL,
                futureApprovalProposal,
                MoaDraftInsertionPolicy.Approval.explicitLocal(futureApprovalProposal, NOW + 1),
                target,
                NOW
        );

        MoaDraftInsertionPolicy.EditableTarget oldTarget = target(
                editor("pkg", 7, "body"), NOW - MoaDraftInsertionPolicy.MAX_TARGET_AGE_MS - 1);
        assertReason(MoaDraftInsertionPolicy.Reason.STALE_TARGET, proposal, approval, oldTarget, NOW);
        MoaDraftInsertionPolicy.EditableTarget futureTarget = target(editor("pkg", 7, "body"), NOW + 1);
        assertReason(MoaDraftInsertionPolicy.Reason.STALE_TARGET, proposal, approval, futureTarget, NOW);
        assertReason(MoaDraftInsertionPolicy.Reason.UNSUPPORTED_TARGET, proposal, approval, null, NOW);
    }

    @Test
    public void packageFingerprintAndSensitivityFailClosed() {
        MoaDraftInsertionPolicy.EditableTarget target = target(editor("pkg", 7, "body"), NOW);
        MoaDraftInsertionPolicy.Proposal proposal = MoaDraftInsertionPolicy.Proposal.insert(
                "proposal", "text", target, NOW);
        MoaDraftInsertionPolicy.Approval approval =
                MoaDraftInsertionPolicy.Approval.explicitLocal(proposal, NOW);

        assertReason(
                MoaDraftInsertionPolicy.Reason.PACKAGE_MISMATCH,
                proposal,
                approval,
                target(editor("other.pkg", 7, "body"), NOW),
                NOW
        );
        assertReason(
                MoaDraftInsertionPolicy.Reason.TARGET_MISMATCH,
                proposal,
                approval,
                target(editor("pkg", 8, "body"), NOW),
                NOW
        );

        MoaEditorSensitivityPolicy.EditorIdentity password = new MoaEditorSensitivityPolicy.EditorIdentity(
                "pkg",
                7,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD,
                0,
                "password",
                "Password",
                ""
        );
        MoaDraftInsertionPolicy.EditableTarget passwordTarget = target(password, NOW);
        MoaDraftInsertionPolicy.Proposal passwordProposal = MoaDraftInsertionPolicy.Proposal.insert(
                "password-proposal", "must not insert", passwordTarget, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.SENSITIVE_TARGET,
                passwordProposal,
                MoaDraftInsertionPolicy.Approval.explicitLocal(passwordProposal, NOW),
                passwordTarget,
                NOW
        );
    }

    @Test
    public void invalidEmptyOversizedAndSendProposalsNeverInvokeEffect() {
        MoaDraftInsertionPolicy.EditableTarget target = target(editor("pkg", 7, "body"), NOW);
        assertReason(MoaDraftInsertionPolicy.Reason.INVALID_PROPOSAL, null, null, target, NOW);

        MoaDraftInsertionPolicy.Proposal invalid = MoaDraftInsertionPolicy.Proposal.insert(
                null, null, null, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.INVALID_PROPOSAL,
                invalid,
                MoaDraftInsertionPolicy.Approval.explicitLocal(invalid, NOW),
                target,
                NOW
        );
        MoaDraftInsertionPolicy.Proposal missingTarget = MoaDraftInsertionPolicy.Proposal.insert(
                "missing-target", "text", null, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.INVALID_PROPOSAL,
                missingTarget,
                MoaDraftInsertionPolicy.Approval.explicitLocal(missingTarget, NOW),
                target,
                NOW
        );
        assertEquals("", MoaDraftInsertionPolicy.Approval.explicitLocal(null, NOW).proposalId);

        MoaDraftInsertionPolicy.Proposal empty = MoaDraftInsertionPolicy.Proposal.insert(
                "empty", "", target, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.EMPTY_TEXT,
                empty,
                MoaDraftInsertionPolicy.Approval.explicitLocal(empty, NOW),
                target,
                NOW
        );

        MoaDraftInsertionPolicy.Proposal large = MoaDraftInsertionPolicy.Proposal.insert(
                "large", "x".repeat(MoaDraftInsertionPolicy.MAX_TEXT_CHARS + 1), target, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.TEXT_TOO_LARGE,
                large,
                MoaDraftInsertionPolicy.Approval.explicitLocal(large, NOW),
                target,
                NOW
        );

        MoaDraftInsertionPolicy.Proposal send = MoaDraftInsertionPolicy.Proposal.send("send", target, NOW);
        assertReason(
                MoaDraftInsertionPolicy.Reason.SEND_UNSUPPORTED,
                send,
                MoaDraftInsertionPolicy.Approval.explicitLocal(send, NOW),
                target,
                NOW
        );
    }

    @Test
    public void failedOrMissingPlatformEffectIsTerminalAndNeverRetries() {
        MoaDraftInsertionPolicy.EditableTarget target = target(editor("pkg", 7, "body"), NOW);
        MoaDraftInsertionPolicy.Proposal proposal = MoaDraftInsertionPolicy.Proposal.insert(
                "failed", "text", target, NOW);
        MoaDraftInsertionPolicy.Approval approval =
                MoaDraftInsertionPolicy.Approval.explicitLocal(proposal, NOW);
        MoaDraftInsertionPolicy.Controller controller = new MoaDraftInsertionPolicy.Controller();

        MoaDraftInsertionPolicy.Receipt failed = controller.execute(
                proposal, approval, target, NOW, exactText -> false);
        assertFalse(failed.succeeded());
        assertEquals(MoaDraftInsertionPolicy.Status.FAILED, failed.status);
        assertEquals(MoaDraftInsertionPolicy.Reason.EFFECT_FAILED, failed.reason);
        assertEquals(
                MoaDraftInsertionPolicy.Reason.REPLAYED,
                controller.execute(proposal, approval, target, NOW, exactText -> true).reason
        );

        MoaDraftInsertionPolicy.Proposal missingEffect = MoaDraftInsertionPolicy.Proposal.insert(
                "missing-effect", "text", target, NOW);
        assertEquals(
                MoaDraftInsertionPolicy.Reason.EFFECT_FAILED,
                controller.execute(
                        missingEffect,
                        MoaDraftInsertionPolicy.Approval.explicitLocal(missingEffect, NOW),
                        target,
                        NOW,
                        null
                ).reason
        );
    }

    @Test
    public void userFacingReasonsNeverSuggestSendOrHiddenExecution() {
        assertEquals("Insertion refused", MoaDraftInsertionPolicy.reasonMessage(null));
        assertEquals("Inserted exactly; nothing was submitted",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.NONE));
        assertEquals("Send is a separate unsupported action; nothing was submitted",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.SEND_UNSUPPORTED));
        assertEquals("Draft or editor is stale; review it again",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.EXPIRED_PROPOSAL));
        assertEquals("Draft or editor is stale; review it again",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.STALE_TARGET));
        assertEquals("Editor changed; draft was not inserted",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.PACKAGE_MISMATCH));
        assertEquals("Editor changed; draft was not inserted",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.TARGET_MISMATCH));
        assertEquals("Sensitive editor: insertion blocked",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.SENSITIVE_TARGET));
        assertEquals("Editor refused insertion",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.EFFECT_FAILED));
        assertEquals("Draft approval was already consumed",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.REPLAYED));
        assertEquals("Insertion refused",
                MoaDraftInsertionPolicy.reasonMessage(MoaDraftInsertionPolicy.Reason.MISSING_APPROVAL));
    }

    private static void assertReason(
            MoaDraftInsertionPolicy.Reason expected,
            MoaDraftInsertionPolicy.Proposal proposal,
            MoaDraftInsertionPolicy.Approval approval,
            MoaDraftInsertionPolicy.EditableTarget target,
            long now
    ) {
        AtomicInteger calls = new AtomicInteger();
        MoaDraftInsertionPolicy.Receipt receipt = new MoaDraftInsertionPolicy.Controller().execute(
                proposal,
                approval,
                target,
                now,
                exactText -> {
                    calls.incrementAndGet();
                    return true;
                }
        );
        assertEquals(MoaDraftInsertionPolicy.Status.REFUSED, receipt.status);
        assertEquals(expected, receipt.reason);
        assertFalse(receipt.succeeded());
        assertEquals(0, calls.get());
    }

    private static MoaDraftInsertionPolicy.EditableTarget target(
            MoaEditorSensitivityPolicy.EditorIdentity editor,
            long observedAtMs
    ) {
        return MoaDraftInsertionPolicy.EditableTarget.fromEditor(editor, observedAtMs);
    }

    private static MoaEditorSensitivityPolicy.EditorIdentity editor(
            String packageName,
            int fieldId,
            String fieldName
    ) {
        return new MoaEditorSensitivityPolicy.EditorIdentity(
                packageName,
                fieldId,
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_LONG_MESSAGE,
                0,
                fieldName,
                "Message",
                ""
        );
    }
}

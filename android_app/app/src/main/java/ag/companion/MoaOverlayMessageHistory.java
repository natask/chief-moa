package ag.companion;

import org.json.JSONObject;
import java.util.List;

/** Exact local projection updates for the compact overlay's bounded messages. */
final class MoaOverlayMessageHistory {
    private MoaOverlayMessageHistory() {}

    static void add(List<ChatMessage> messages, ChatMessage message, int maximum, Runnable render) {
        if (message == null || message.text.trim().isEmpty()) return;
        messages.add(message);
        while (messages.size() > maximum) messages.remove(0);
        render.run();
    }

    static boolean replaceFinalizedUser(List<ChatMessage> messages, JSONObject event,
            String activeSessionId, String activeBranchId, String activeTurnId,
            String expectedOwnerId, Runnable render) {
        for (int index = messages.size() - 1; index >= 0; index--) {
            ChatMessage message = messages.get(index);
            MoaTranscriptRevisionGate.Snapshot accepted = MoaTranscriptRevisionGate.acceptCompletedMessage(
                    event, message, activeSessionId, activeBranchId, activeTurnId, expectedOwnerId);
            if (accepted == null) continue;
            messages.set(index, message.correctedTranscript(accepted.text.trim(), accepted.correctionRevision));
            render.run();
            return true;
        }
        return false;
    }
}

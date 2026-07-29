package ag.companion;

import java.util.List;

final class MoaOrbTouchActionDispatcher {
    private MoaOrbTouchActionDispatcher() {
    }

    static void dispatch(
            List<MoaVoiceFirstTapResolver.Action> actions,
            Runnable onStartTalkLoop,
            Runnable onSendTalkLoop,
            Runnable onCancelTalkLoop,
            Runnable onStartFreshTalkLoop,
            Runnable onOpenChat
    ) {
        for (MoaVoiceFirstTapResolver.Action action : actions) {
            switch (action) {
                case START_OR_INTERRUPT:
                    onStartTalkLoop.run();
                    break;
                case STOP_AND_SEND:
                    onSendTalkLoop.run();
                    break;
                case CANCEL_CAPTURE:
                    onCancelTalkLoop.run();
                    break;
                case START_FRESH:
                    onStartFreshTalkLoop.run();
                    break;
                case OPEN_CHAT:
                    onOpenChat.run();
                    break;
                default:
                    break;
            }
        }
    }
}

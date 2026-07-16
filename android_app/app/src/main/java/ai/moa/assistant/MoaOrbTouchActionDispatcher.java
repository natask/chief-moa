package ai.moa.assistant;

import java.util.List;

final class MoaOrbTouchActionDispatcher {
    private MoaOrbTouchActionDispatcher() {
    }

    static void dispatch(
            List<MoaVoiceFirstTapResolver.Action> actions,
            Runnable onStartTalkLoop,
            Runnable onSendTalkLoop,
            Runnable onHardInterrupt
    ) {
        for (MoaVoiceFirstTapResolver.Action action : actions) {
            switch (action) {
                case START_OR_CONTINUE:
                    onStartTalkLoop.run();
                    break;
                case STOP_AND_SEND:
                    onSendTalkLoop.run();
                    break;
                case HARD_INTERRUPT:
                    onHardInterrupt.run();
                    break;
                default:
                    break;
            }
        }
    }
}

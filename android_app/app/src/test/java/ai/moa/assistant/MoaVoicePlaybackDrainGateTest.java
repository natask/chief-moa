package ai.moa.assistant;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaVoicePlaybackDrainGateTest {
    @Test
    public void pcmAudioDoneThenImmediateCompletedTurnKeepsDrainOwnership() {
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onPlaybackStarted();
        gate.onAudioDone(true);

        assertTrue(gate.ownsCompletedTurn());
        assertFalse(gate.shouldStopOnTurnDone("completed"));

        gate.onPlaybackStopped();
        assertFalse(gate.ownsCompletedTurn());
    }

    @Test
    public void disabledPlaybackNeedsNoDrainAndNoStop() {
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onAudioDone(false);

        assertFalse(gate.ownsCompletedTurn());
        assertFalse(gate.shouldStopOnTurnDone("completed"));
    }

    @Test
    public void errorMayStopInFlightPlayback() {
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onPlaybackStarted();
        gate.onAudioDone(true);

        assertTrue(gate.shouldStopOnTurnDone("error"));
    }
}

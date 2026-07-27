package ai.moa.assistant;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaVoicePlaybackDrainGateTest {
    @Test
    public void pcmAudioDoneThenImmediateCompletedTurnKeepsDrainOwnership() {
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onPlaybackStarted();
        assertFalse(gate.onProviderAudioDone(true));

        assertTrue(gate.ownsCompletedTurn());
        assertFalse(gate.shouldStopOnTurnDone("completed"));
        assertFalse("provider audio_done and turn_done cannot complete device audio",
                gate.onPlaybackStopped(false));
        assertFalse("a timeout cannot later emit completion", gate.onPlaybackStopped(true));
    }

    @Test
    public void deviceDrainCompletionIsDeliveredOnlyAfterSuccessfulDrain() {
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onPlaybackStarted();
        assertFalse(gate.onProviderAudioDone(true));
        assertFalse(gate.shouldStopOnTurnDone("completed"));

        assertTrue(gate.onPlaybackStopped(true));
        assertFalse(gate.ownsCompletedTurn());
        assertFalse("completion is one-shot", gate.onPlaybackStopped(true));
    }

    @Test
    public void disabledPlaybackNeedsNoDrainAndNoStop() {
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        assertTrue(gate.onProviderAudioDone(false));

        assertFalse(gate.ownsCompletedTurn());
        assertFalse(gate.shouldStopOnTurnDone("completed"));
    }

    @Test
    public void errorMayStopInFlightPlayback() {
        MoaVoicePlaybackDrainGate gate = new MoaVoicePlaybackDrainGate();
        gate.onPlaybackStarted();
        assertFalse(gate.onProviderAudioDone(true));

        assertTrue(gate.shouldStopOnTurnDone("error"));
    }
}

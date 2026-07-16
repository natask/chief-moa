package ai.moa.assistant;

import org.junit.Test;

import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public final class MoaVoiceFirstTapResolverTest {
    @Test public void singleIdleStartsCurrentThread() {
        MoaVoiceFirstTapResolver resolver = tapped(1);
        assertEquals(Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_OR_CONTINUE),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.NONE));
        assertFalse(resolver.hasOpenChord());
    }

    @Test public void singleRecordingSends() {
        MoaVoiceFirstTapResolver resolver = tapped(1);
        assertEquals(Collections.singletonList(MoaVoiceFirstTapResolver.Action.STOP_AND_SEND),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.CURRENT_THREAD));
    }

    @Test public void doubleIdleContinuesSameThread() {
        MoaVoiceFirstTapResolver resolver = tapped(2);
        assertEquals(Collections.singletonList(MoaVoiceFirstTapResolver.Action.START_OR_CONTINUE),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.NONE));
    }

    @Test public void doubleRecordingDoesNotReplaceOrCommitCapture() {
        MoaVoiceFirstTapResolver resolver = tapped(2);
        assertEquals(Collections.emptyList(),
                resolver.resolve(MoaVoiceFirstTapResolver.CaptureOrigin.CURRENT_THREAD));
    }

    @Test public void tripleAlwaysHardInterrupts() {
        for (MoaVoiceFirstTapResolver.CaptureOrigin origin : MoaVoiceFirstTapResolver.CaptureOrigin.values()) {
            MoaVoiceFirstTapResolver resolver = tapped(3);
            assertEquals(Collections.singletonList(MoaVoiceFirstTapResolver.Action.HARD_INTERRUPT),
                    resolver.resolve(origin));
        }
    }

    @Test public void fourthTapIsInert() {
        assertEquals(Collections.emptyList(),
                tapped(4).resolve(MoaVoiceFirstTapResolver.CaptureOrigin.NONE));
    }

    private static MoaVoiceFirstTapResolver tapped(int count) {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        for (int i = 0; i < count; i++) resolver.tapUp();
        return resolver;
    }
}

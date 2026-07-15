package ai.moa.assistant;

import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;

public final class MoaOrbTouchListenerTest {
    @Test
    public void freshCaptureSingleTapCannotReachSendCallback() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        List<MoaVoiceFirstTapResolver.Action> actions = resolver.resolve(
                MoaVoiceFirstTapResolver.CaptureOrigin.FRESH_THREAD
        );
        AtomicInteger starts = new AtomicInteger();
        AtomicInteger sends = new AtomicInteger();
        AtomicInteger cancels = new AtomicInteger();
        AtomicInteger freshStarts = new AtomicInteger();
        AtomicInteger chats = new AtomicInteger();

        MoaOrbTouchActionDispatcher.dispatch(
                actions,
                starts::incrementAndGet,
                sends::incrementAndGet,
                cancels::incrementAndGet,
                freshStarts::incrementAndGet,
                chats::incrementAndGet
        );

        assertEquals(0, starts.get());
        assertEquals(0, sends.get());
        assertEquals(0, cancels.get());
        assertEquals(0, freshStarts.get());
        assertEquals(0, chats.get());
    }

    @Test
    public void freshCaptureDoubleTapReachesOnlySendCallback() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();
        List<MoaVoiceFirstTapResolver.Action> actions = resolver.resolve(
                MoaVoiceFirstTapResolver.CaptureOrigin.FRESH_THREAD
        );
        AtomicInteger starts = new AtomicInteger();
        AtomicInteger sends = new AtomicInteger();
        AtomicInteger cancels = new AtomicInteger();
        AtomicInteger freshStarts = new AtomicInteger();
        AtomicInteger chats = new AtomicInteger();

        MoaOrbTouchActionDispatcher.dispatch(
                actions,
                starts::incrementAndGet,
                sends::incrementAndGet,
                cancels::incrementAndGet,
                freshStarts::incrementAndGet,
                chats::incrementAndGet
        );

        assertEquals(0, starts.get());
        assertEquals(1, sends.get());
        assertEquals(0, cancels.get());
        assertEquals(0, freshStarts.get());
        assertEquals(0, chats.get());
    }

    @Test
    public void freshCaptureTripleTapCancelsAndOpensChatWithoutSending() {
        MoaVoiceFirstTapResolver resolver = new MoaVoiceFirstTapResolver();
        resolver.tapUp();
        resolver.tapUp();
        resolver.tapUp();
        List<MoaVoiceFirstTapResolver.Action> actions = resolver.resolve(
                MoaVoiceFirstTapResolver.CaptureOrigin.FRESH_THREAD
        );
        AtomicInteger starts = new AtomicInteger();
        AtomicInteger sends = new AtomicInteger();
        AtomicInteger cancels = new AtomicInteger();
        AtomicInteger freshStarts = new AtomicInteger();
        AtomicInteger chats = new AtomicInteger();

        MoaOrbTouchActionDispatcher.dispatch(
                actions,
                starts::incrementAndGet,
                sends::incrementAndGet,
                cancels::incrementAndGet,
                freshStarts::incrementAndGet,
                chats::incrementAndGet
        );

        assertEquals(0, starts.get());
        assertEquals(0, sends.get());
        assertEquals(1, cancels.get());
        assertEquals(0, freshStarts.get());
        assertEquals(1, chats.get());
    }
}

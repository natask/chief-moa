package ai.moa.assistant;

import android.content.Context;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;

import java.time.Duration;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;

@RunWith(RobolectricTestRunner.class)
public final class MoaOrbTouchListenerTest {
    @Test
    public void movingConfirmedHoldKeepsCaptureAndCommitsOnRelease() {
        Context context = RuntimeEnvironment.getApplication();
        WindowManager.LayoutParams params = new WindowManager.LayoutParams();
        params.x = 100;
        params.y = 100;
        AtomicInteger releases = new AtomicInteger();
        AtomicInteger cancels = new AtomicInteger();
        AtomicInteger dragStarts = new AtomicInteger();
        AtomicInteger dragEnds = new AtomicInteger();

        MoaOrbTouchListener listener = new MoaOrbTouchListener(
                context, params, 64, 12,
                () -> {}, () -> {}, releases::incrementAndGet,
                () -> {}, () -> {},
                () -> true,
                () -> MoaVoiceFirstTapResolver.CaptureOrigin.NONE,
                () -> {}, () -> {}, () -> {}, () -> {}, () -> {},
                cancels::incrementAndGet,
                dragStarts::incrementAndGet, () -> {},
                completed -> dragEnds.incrementAndGet()
        );
        View view = new View(context);

        listener.onTouch(view, event(MotionEvent.ACTION_DOWN, 100, 100));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300));
        listener.onTouch(view, event(MotionEvent.ACTION_MOVE, 240, 240));
        listener.onTouch(view, event(MotionEvent.ACTION_UP, 240, 240));

        assertEquals(1, releases.get());
        assertEquals(0, cancels.get());
        assertEquals(1, dragStarts.get());
        assertEquals(1, dragEnds.get());
    }

    private static MotionEvent event(int action, float x, float y) {
        return MotionEvent.obtain(0, 0, action, x, y, 0);
    }

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

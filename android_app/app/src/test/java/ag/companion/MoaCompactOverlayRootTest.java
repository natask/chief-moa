package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.graphics.Rect;
import android.view.View;
import android.view.WindowManager;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.lang.reflect.Proxy;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
public class MoaCompactOverlayRootTest {
    @Test
    public void transparentUnionGapHasNoOverlayWindow() {
        RecordingWindowManager recording = new RecordingWindowManager();
        MoaCompactOverlayRoot root = root(recording);
        View companion = view();
        View youRibbon = view();
        View replyRibbon = view();
        root.put(companion, new Rect(150, 206, 217, 273), true);
        root.put(youRibbon, new Rect(184, 160, 464, 200), true);
        root.put(replyRibbon, new Rect(0, 279, 280, 319), true);

        root.attach();
        root.commitFrame();

        assertEquals(3, recording.adds.get());
        assertEquals(new Rect(0, 160, 464, 319), root.windowBoundsForTest());
        assertTrue(root.windowBoundsForTest().contains(400, 240));
        assertFalse(recording.isCovered(400, 240));
        assertTrue(recording.isCovered(180, 240));
    }

    @Test
    public void latestDragFrameMovesEachBoundedWindowOnce() {
        RecordingWindowManager recording = new RecordingWindowManager();
        MoaCompactOverlayRoot root = root(recording);
        View companion = view();
        View ribbon = view();
        root.put(companion, new Rect(100, 200, 180, 280), true);
        root.put(ribbon, new Rect(180, 160, 420, 200), true);
        root.attach();

        root.translateSlots(160, 220);
        root.commitFrame();

        assertEquals(2, recording.updates.get());
        assertEquals(new Rect(260, 420, 340, 500), recording.bounds.get(companion));
        assertEquals(new Rect(340, 380, 580, 420), recording.bounds.get(ribbon));
    }

    @Test
    public void dormantRibbonWindowIsNotTouchable() {
        RecordingWindowManager recording = new RecordingWindowManager();
        MoaCompactOverlayRoot root = root(recording);
        View ribbon = view();
        root.put(ribbon, new Rect(20, 40, 300, 80), false);

        root.attach();

        assertTrue((recording.flags.get(ribbon)
                & WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE) != 0);
    }

    private static MoaCompactOverlayRoot root(RecordingWindowManager recording) {
        return new MoaCompactOverlayRoot(
                RuntimeEnvironment.getApplication(), recording.manager,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY);
    }

    private static View view() {
        View view = new View(RuntimeEnvironment.getApplication());
        view.setAlpha(1f);
        return view;
    }

    private static final class RecordingWindowManager {
        final AtomicInteger adds = new AtomicInteger();
        final AtomicInteger updates = new AtomicInteger();
        final Map<View, Rect> bounds = new IdentityHashMap<>();
        final Map<View, Integer> flags = new IdentityHashMap<>();
        final WindowManager manager = (WindowManager) Proxy.newProxyInstance(
                WindowManager.class.getClassLoader(),
                new Class<?>[]{WindowManager.class},
                (proxy, method, args) -> {
                    if ("addView".equals(method.getName())) {
                        adds.incrementAndGet();
                        record(args);
                    } else if ("updateViewLayout".equals(method.getName())) {
                        updates.incrementAndGet();
                        record(args);
                    } else if ("removeView".equals(method.getName())) {
                        bounds.remove((View) args[0]);
                        flags.remove((View) args[0]);
                    }
                    Class<?> type = method.getReturnType();
                    if (type == boolean.class) return false;
                    if (type == int.class) return 0;
                    return null;
                });

        boolean isCovered(int x, int y) {
            for (Map.Entry<View, Rect> entry : bounds.entrySet()) {
                int windowFlags = flags.get(entry.getKey());
                if ((windowFlags & WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE) == 0
                        && entry.getValue().contains(x, y)) return true;
            }
            return false;
        }

        private void record(Object[] args) {
            View view = (View) args[0];
            WindowManager.LayoutParams params = (WindowManager.LayoutParams) args[1];
            bounds.put(view, new Rect(
                    params.x, params.y, params.x + params.width, params.y + params.height));
            flags.put(view, params.flags);
        }
    }
}

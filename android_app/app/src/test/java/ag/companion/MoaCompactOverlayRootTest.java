package ag.companion;

import static org.junit.Assert.assertEquals;

import android.graphics.Rect;
import android.view.View;
import android.view.WindowManager;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
public class MoaCompactOverlayRootTest {
    @Test
    public void oneCommitSubmitsExactlyOneRootWindowLayout() {
        AtomicInteger updates = new AtomicInteger();
        WindowManager manager = recordingManager(updates);
        MoaCompactOverlayRoot root = new MoaCompactOverlayRoot(
                RuntimeEnvironment.getApplication(), manager,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY);
        View companion = new View(RuntimeEnvironment.getApplication());
        View ribbon = new View(RuntimeEnvironment.getApplication());
        root.put(companion, new Rect(100, 200, 180, 280), true);
        root.put(ribbon, new Rect(40, 160, 280, 200), true);
        root.attach();

        root.commitFrame();

        assertEquals(1, updates.get());
        assertEquals(new Rect(40, 160, 280, 280), root.windowBoundsForTest());
    }

    @Test
    public void latestDragFrameMovesTheRootWithOneSubmission() {
        AtomicInteger updates = new AtomicInteger();
        MoaCompactOverlayRoot root = new MoaCompactOverlayRoot(
                RuntimeEnvironment.getApplication(), recordingManager(updates),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY);
        View companion = new View(RuntimeEnvironment.getApplication());
        root.put(companion, new Rect(100, 200, 180, 280), true);
        root.attach();
        root.commitFrame();
        updates.set(0);

        root.translateSlots(160, 220);
        root.commitFrame();

        assertEquals(1, updates.get());
        assertEquals(new Rect(260, 420, 340, 500), root.windowBoundsForTest());
    }

    private static WindowManager recordingManager(AtomicInteger updates) {
        return (WindowManager) Proxy.newProxyInstance(
                WindowManager.class.getClassLoader(),
                new Class<?>[]{WindowManager.class},
                (proxy, method, args) -> {
                    if ("updateViewLayout".equals(method.getName())) updates.incrementAndGet();
                    Class<?> type = method.getReturnType();
                    if (type == boolean.class) return false;
                    if (type == int.class) return 0;
                    return null;
                });
    }
}

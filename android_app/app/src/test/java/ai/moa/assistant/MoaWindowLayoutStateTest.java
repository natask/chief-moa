package ai.moa.assistant;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.view.WindowManager;

import org.junit.Test;

public final class MoaWindowLayoutStateTest {
    @Test
    public void paintOnlyRenderDoesNotResubmitUnchangedLayout() {
        MoaWindowLayoutState state = new MoaWindowLayoutState();
        WindowManager.LayoutParams params = params();

        assertTrue(state.changed(params));
        assertFalse(state.changed(params));
    }

    @Test
    public void geometryFlagsAndResetEachRequireSubmission() {
        MoaWindowLayoutState state = new MoaWindowLayoutState();
        WindowManager.LayoutParams params = params();
        assertTrue(state.changed(params));

        params.height++;
        assertTrue(state.changed(params));
        params.x += 20;
        assertTrue(state.changed(params));
        params.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        assertTrue(state.changed(params));
        assertFalse(state.changed(params));

        state.reset();
        assertTrue(state.changed(params));
    }

    private static WindowManager.LayoutParams params() {
        WindowManager.LayoutParams params = new WindowManager.LayoutParams();
        params.x = 30;
        params.y = 40;
        params.width = 280;
        params.height = 36;
        params.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        return params;
    }
}

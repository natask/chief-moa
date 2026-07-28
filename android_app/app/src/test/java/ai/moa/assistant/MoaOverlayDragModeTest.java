package ai.moa.assistant;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MoaOverlayDragModeTest {
    @Test
    public void dragFramesSubmitOnlyTheCompanion() {
        MoaOverlayDragMode mode = new MoaOverlayDragMode();
        assertTrue(mode.begin());

        int companionSubmissions = 0;
        int dependentSubmissions = 0;
        for (int frame = 0; frame < 20; frame++) {
            MoaOverlayDragMode.FramePlan plan = mode.movingFrame();
            assertTrue(plan.submitCompanion);
            assertFalse(plan.submitDependents);
            companionSubmissions += plan.submitCompanion ? 1 : 0;
            dependentSubmissions += plan.submitDependents ? 1 : 0;
        }
        org.junit.Assert.assertEquals(20, companionSubmissions);
        org.junit.Assert.assertEquals(0, dependentSubmissions);
    }

    @Test
    public void finishRestoresDependentsExactlyOnce() {
        MoaOverlayDragMode mode = new MoaOverlayDragMode();
        assertTrue(mode.begin());
        assertFalse(mode.begin());
        assertTrue(mode.isDragging());

        assertTrue(mode.finish());
        assertFalse(mode.finish());
        assertFalse(mode.isDragging());
        assertTrue(mode.movingFrame().submitDependents);
    }
}

package ai.moa.assistant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaOrbRemovalUndoTest {

    @Test
    public void undoRestoresWhereTheDragStartedNotWhereItWasDropped() {
        MoaOrbRemovalUndo undo = new MoaOrbRemovalUndo();
        undo.arm(880, 460, 1000);

        assertTrue(undo.consume(1500));
        assertEquals(880, undo.restoreX());
        assertEquals(460, undo.restoreY());
    }

    @Test
    public void theUndoWindowCloses() {
        MoaOrbRemovalUndo undo = new MoaOrbRemovalUndo();
        undo.arm(10, 20, 1000);

        assertTrue(undo.pending(1000 + MoaOrbRemovalUndo.WINDOW_MS - 1));
        assertFalse(undo.pending(1000 + MoaOrbRemovalUndo.WINDOW_MS));
        assertTrue(undo.expired(1000 + MoaOrbRemovalUndo.WINDOW_MS));
        assertFalse(undo.consume(1000 + MoaOrbRemovalUndo.WINDOW_MS));
    }

    @Test
    public void undoCanOnlyBeTakenOnce() {
        MoaOrbRemovalUndo undo = new MoaOrbRemovalUndo();
        undo.arm(10, 20, 1000);

        assertTrue(undo.consume(1100));
        assertFalse(undo.consume(1200));
    }

    @Test
    public void nothingIsPendingBeforeARemoval() {
        MoaOrbRemovalUndo undo = new MoaOrbRemovalUndo();

        assertFalse(undo.pending(1000));
        assertFalse(undo.expired(1000));
        assertEquals(0, undo.remainingMs(1000));
    }

    @Test
    public void remainingTimeCountsDownAndFloorsAtZero() {
        MoaOrbRemovalUndo undo = new MoaOrbRemovalUndo();
        undo.arm(0, 0, 1000);

        assertEquals(MoaOrbRemovalUndo.WINDOW_MS, undo.remainingMs(1000));
        assertEquals(1, undo.remainingMs(1000 + MoaOrbRemovalUndo.WINDOW_MS - 1));
        assertEquals(0, undo.remainingMs(9_000_000));
    }
}

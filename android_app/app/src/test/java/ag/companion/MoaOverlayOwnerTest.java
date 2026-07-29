package ag.companion;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class MoaOverlayOwnerTest {
    @Test
    public void onlyOneDistinctOwnerCanClaimTheOverlay() {
        MoaOverlayOwner owner = new MoaOverlayOwner();
        Object first = new Object();
        Object second = new Object();

        assertTrue(owner.claim(first));
        assertTrue(owner.claim(first));
        assertFalse(owner.claim(second));
        assertTrue(owner.isOwner(first));
        assertFalse(owner.isOwner(second));
    }

    @Test
    public void onlyTheCurrentOwnerCanReleaseForAReplacement() {
        MoaOverlayOwner owner = new MoaOverlayOwner();
        Object first = new Object();
        Object second = new Object();

        assertTrue(owner.claim(first));
        owner.release(second);
        assertFalse(owner.claim(second));

        owner.release(first);
        assertTrue(owner.claim(second));
    }
}

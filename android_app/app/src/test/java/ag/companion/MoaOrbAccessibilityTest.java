package ag.companion;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.view.accessibility.AccessibilityNodeInfo;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 26)
public final class MoaOrbAccessibilityTest {
    @Test
    public void activeDraftExposesIndependentSendAndDiscardActions() {
        Application context = RuntimeEnvironment.getApplication();
        OrbView orb = new OrbView(context);
        AtomicInteger sends = new AtomicInteger();
        AtomicInteger discards = new AtomicInteger();
        orb.setVoiceDraftAccessibilityActions(
                true, sends::incrementAndGet, discards::incrementAndGet);

        AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain();
        orb.onInitializeAccessibilityNodeInfo(info);
        int sendAction = actionId(info, "Send voice draft");
        int discardAction = actionId(info, "Discard voice draft");

        assertTrue(sendAction != 0);
        assertTrue(discardAction != 0);
        assertTrue(orb.performAccessibilityAction(sendAction, null));
        assertTrue(orb.performAccessibilityAction(discardAction, null));
        assertEquals(1, sends.get());
        assertEquals(1, discards.get());
        info.recycle();

        orb.setVoiceDraftAccessibilityActions(false, null, null);
        AccessibilityNodeInfo inactive = AccessibilityNodeInfo.obtain();
        orb.onInitializeAccessibilityNodeInfo(inactive);
        assertEquals(0, actionId(inactive, "Send voice draft"));
        assertEquals(0, actionId(inactive, "Discard voice draft"));
        assertFalse(orb.performAccessibilityAction(sendAction, null));
        assertFalse(orb.performAccessibilityAction(discardAction, null));
        assertEquals(1, sends.get());
        assertEquals(1, discards.get());
        inactive.recycle();
    }

    private static int actionId(AccessibilityNodeInfo info, String label) {
        for (AccessibilityNodeInfo.AccessibilityAction action : info.getActionList()) {
            if (label.contentEquals(action.getLabel())) {
                return action.getId();
            }
        }
        return 0;
    }
}

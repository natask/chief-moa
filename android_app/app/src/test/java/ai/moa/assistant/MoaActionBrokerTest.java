package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class MoaActionBrokerTest {
    @Test
    public void extractsExplicitOpenAppTargets() {
        assertEquals("Chrome", MoaActionBroker.openAppTarget("/open app Chrome"));
        assertEquals("Gmail", MoaActionBroker.openAppTarget("open app Gmail"));
        assertEquals("Google Maps", MoaActionBroker.openAppTarget("launch app Google Maps"));
        assertEquals("", MoaActionBroker.openAppTarget("open chrome.com"));
    }

    @Test
    public void normalizesAppLabels() {
        assertEquals("google chrome", MoaActionBroker.normalizeAppLabel("Google Chrome"));
        assertEquals("com android chrome", MoaActionBroker.normalizeAppLabel("com.android.chrome"));
    }
}

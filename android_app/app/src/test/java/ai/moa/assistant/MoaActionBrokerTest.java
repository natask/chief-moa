package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

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

    @Test
    public void identifiesAppListCommands() {
        assertTrue(MoaActionBroker.isAppListCommand("/apps"));
        assertTrue(MoaActionBroker.isAppListCommand(" /List Apps "));
        assertFalse(MoaActionBroker.isAppListCommand("list apps"));
        assertFalse(MoaActionBroker.isAppListCommand("/open app Messages"));
    }

    @Test
    public void formatsAppListRepliesWithLimits() {
        assertEquals(
                "Installed apps (2 of 3): Chrome, Gmail. Say /open app <name> to launch one.",
                MoaActionBroker.formatAppListReply(Arrays.asList("Chrome", "Gmail", "Maps"), 2)
        );
        assertEquals(
                "No launcher apps were visible.",
                MoaActionBroker.formatAppListReply(Collections.emptyList(), 10)
        );
        assertEquals(40, MoaActionBroker.boundedAppListLimit(0));
        assertEquals(120, MoaActionBroker.boundedAppListLimit(200));
    }

    @Test
    public void extractsDraftComposeInputs() throws Exception {
        JSONObject email = new JSONObject()
                .put("recipient", "nat@example.com")
                .put("title", "Status")
                .put("message", "Build passed.");
        assertEquals("nat@example.com", MoaActionBroker.emailDraftRecipient(email));
        assertEquals("Status", MoaActionBroker.emailDraftSubject(email));
        assertEquals("Build passed.", MoaActionBroker.emailDraftBody(email));

        JSONObject sms = new JSONObject()
                .put("phone", "+15551234567")
                .put("text", "On my way.");
        assertEquals("+15551234567", MoaActionBroker.smsDraftRecipient(sms));
        assertEquals("On my way.", MoaActionBroker.smsDraftBody(sms));
    }
}

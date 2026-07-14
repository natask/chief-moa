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

    @Test
    public void allowsOnlyHttpAndHttpsUrls() {
        assertEquals("https://example.com", MoaActionBroker.sanitizeOpenUrl("https://example.com"));
        assertEquals("http://example.com/x?q=1", MoaActionBroker.sanitizeOpenUrl(" http://example.com/x?q=1 "));
        // Scheme match is case-insensitive but the URL itself is returned as-is.
        assertEquals("HTTPS://Example.com", MoaActionBroker.sanitizeOpenUrl("HTTPS://Example.com"));
        assertEquals("", MoaActionBroker.sanitizeOpenUrl("javascript:alert(1)"));
        assertEquals("", MoaActionBroker.sanitizeOpenUrl("file:///etc/passwd"));
        assertEquals("", MoaActionBroker.sanitizeOpenUrl("intent://scan/#Intent;end"));
        assertEquals("", MoaActionBroker.sanitizeOpenUrl("example.com"));
        assertEquals("", MoaActionBroker.sanitizeOpenUrl(""));
        assertEquals("", MoaActionBroker.sanitizeOpenUrl(null));
    }

    @Test
    public void normalizesDialNumbers() {
        assertEquals("+15551234567", MoaActionBroker.normalizeDialNumber("+1 (555) 123-4567"));
        assertEquals("5551234567", MoaActionBroker.normalizeDialNumber("555-123-4567"));
        assertEquals("+441234", MoaActionBroker.normalizeDialNumber(" +44 12 34 "));
        assertEquals("5551234", MoaActionBroker.normalizeDialNumber("555.1234"));
        assertEquals("", MoaActionBroker.normalizeDialNumber("call nat"));
        assertEquals("", MoaActionBroker.normalizeDialNumber("+"));
        assertEquals("", MoaActionBroker.normalizeDialNumber("()- "));
        assertEquals("", MoaActionBroker.normalizeDialNumber(""));
        assertEquals("", MoaActionBroker.normalizeDialNumber(null));
    }

    @Test
    public void extractsPhoneToolInputs() throws Exception {
        assertEquals("https://a.com", MoaActionBroker.openUrlTarget(new JSONObject().put("url", "https://a.com")));
        assertEquals("https://b.com", MoaActionBroker.openUrlTarget(new JSONObject().put("link", "https://b.com")));
        assertEquals("+1555", MoaActionBroker.dialNumberTarget(new JSONObject().put("number", "+1555")));
        assertEquals("+1666", MoaActionBroker.dialNumberTarget(new JSONObject().put("phone", "+1666")));
        assertEquals("Mom", MoaActionBroker.contactOpenName(new JSONObject().put("name", "Mom")));
        assertEquals("Dad", MoaActionBroker.contactOpenName(new JSONObject().put("contact", "Dad")));
        assertEquals("", MoaActionBroker.openUrlTarget(new JSONObject()));
    }

    @Test
    public void registersNewPhoneToolsWithContractRiskAndApproval() {
        assertTrue(MoaActionBroker.isKnownTool("url.open"));
        assertTrue(MoaActionBroker.isKnownTool("phone.dial"));
        assertTrue(MoaActionBroker.isKnownTool("contact.open"));
        assertFalse(MoaActionBroker.isKnownTool("phone.call"));

        assertEquals("navigation", MoaActionBroker.capabilityRisk("url.open"));
        assertEquals("implicit_user_command", MoaActionBroker.capabilityApproval("url.open"));
        assertEquals("external_side_effect", MoaActionBroker.capabilityRisk("phone.dial"));
        assertEquals("target_app_confirmation", MoaActionBroker.capabilityApproval("phone.dial"));
        assertEquals("navigation", MoaActionBroker.capabilityRisk("contact.open"));
        assertEquals("implicit_user_command", MoaActionBroker.capabilityApproval("contact.open"));
    }

    @Test
    public void extractsExpectedPackageForScreenBoundActions() throws Exception {
        assertEquals(
                "com.example.mail",
                MoaActionBroker.expectedPackage(new JSONObject().put("expected_package", "com.example.mail"))
        );
        assertEquals(
                "com.example.browser",
                MoaActionBroker.expectedPackage(new JSONObject().put("expectedPackage", "com.example.browser"))
        );
        assertEquals("", MoaActionBroker.expectedPackage(new JSONObject()));
    }

    @Test
    public void reportsContactPermissionAndMissMessages() {
        assertEquals(
                "Contacts permission not granted. Open the A.G. app to grant it.",
                MoaActionBroker.CONTACTS_PERMISSION_MISSING
        );
        assertEquals("No contact found matching \"Mom\".", MoaActionBroker.contactNotFoundReply("Mom"));
    }
}

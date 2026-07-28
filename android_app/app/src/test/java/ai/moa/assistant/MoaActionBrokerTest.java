package ai.moa.assistant;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.Set;

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
                MoaAppLaunchPolicy.formatListReply(Arrays.asList("Chrome", "Gmail"), 3)
        );
        assertEquals(
                "No launcher apps were visible.",
                MoaAppLaunchPolicy.formatListReply(Collections.emptyList(), 0)
        );
        assertEquals(40, MoaAppLaunchPolicy.boundedListLimit(0));
        assertEquals(120, MoaAppLaunchPolicy.boundedListLimit(200));
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

        assertTrue(MoaActionBroker.isKnownTool("media.open"));
        assertTrue(MoaActionBroker.isKnownTool("media.control"));
        assertTrue(MoaActionBroker.isKnownTool("media.bookmark"));
        assertTrue(MoaActionBroker.isKnownTool("media.playlist"));
        assertEquals("local_confirmation", MoaActionBroker.capabilityApproval("media.bookmark"));
        assertEquals("local_confirmation", MoaActionBroker.capabilityApproval("media.playlist"));

        assertTrue(MoaActionBroker.isKnownTool("app.settings.open"));
        assertEquals("navigation", MoaActionBroker.capabilityRisk("app.settings.open"));
        assertEquals("implicit_user_command", MoaActionBroker.capabilityApproval("app.settings.open"));
    }

    @Test
    public void parsesAndBoundsMediaPositions() throws Exception {
        assertEquals(1234L, MoaActionBroker.mediaPositionMs(
                new JSONObject().put("position_ms", 1234L)));
        assertEquals(42_000L, MoaActionBroker.mediaPositionMs(
                new JSONObject().put("start_seconds", 42L)));
        assertEquals(0L, MoaActionBroker.mediaPositionMs(
                new JSONObject().put("position_ms", -10L)));
        assertEquals(MoaMediaSessionController.MAX_MEDIA_TIME_MS, MoaActionBroker.mediaPositionMs(
                new JSONObject().put("position_ms", Long.MAX_VALUE)));
    }

    @Test
    public void absentRevancedFallsBackToApprovedThenOfficial() {
        assertEquals(MoaYoutubeUiPolicy.REVANCED_PACKAGE, MoaActionBroker.fallbackYoutubePackage(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE, "",
                Set.of(MoaYoutubeUiPolicy.REVANCED_PACKAGE)));
        assertEquals("com.example.youtube", MoaActionBroker.fallbackYoutubePackage(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE, "com.example.youtube",
                Set.of("com.example.youtube", MoaYoutubeUiPolicy.OFFICIAL_PACKAGE)));
        assertEquals(MoaYoutubeUiPolicy.OFFICIAL_PACKAGE, MoaActionBroker.fallbackYoutubePackage(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE, "",
                Set.of(MoaYoutubeUiPolicy.OFFICIAL_PACKAGE)));
        assertEquals("", MoaActionBroker.fallbackYoutubePackage(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE, "", Collections.emptySet()));
    }

    @Test
    public void mediaOpenHonorsOnlyDeviceLocalAppNameAliases() {
        Set<String> installed = Set.of(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE, MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                "org.example.youtube.custom");
        assertEquals(MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                MoaActionBroker.resolveMediaOpenAppName("YouTube",
                        MoaYoutubeUiPolicy.REVANCED_PACKAGE, "", "", installed));
        assertEquals(MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                MoaActionBroker.resolveMediaOpenAppName("YouTube Advanced",
                        MoaYoutubeUiPolicy.OFFICIAL_PACKAGE, "", "", installed));
        assertEquals(MoaYoutubeUiPolicy.OFFICIAL_PACKAGE,
                MoaActionBroker.resolveMediaOpenAppName("official YouTube",
                        MoaYoutubeUiPolicy.REVANCED_PACKAGE, "", "", installed));
        assertEquals("org.example.youtube.custom",
                MoaActionBroker.resolveMediaOpenAppName("My Video App",
                        MoaYoutubeUiPolicy.REVANCED_PACKAGE, "org.example.youtube.custom",
                        "My Video App", installed));
        assertEquals("", MoaActionBroker.resolveMediaOpenAppName(
                "org.example.youtube.custom", MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                "org.example.youtube.custom", "My Video App", installed));
        assertEquals("", MoaActionBroker.resolveMediaOpenAppName(
                "Unapproved YouTube Clone", MoaYoutubeUiPolicy.REVANCED_PACKAGE,
                "org.example.youtube.custom", "My Video App", installed));
    }

    @Test
    public void mediaControlBindsFreshSnapshotAndRejectsStaleOptionalBinding() throws Exception {
        MoaMediaSessionController.Snapshot snapshot = new MoaMediaSessionController.Snapshot(
                MoaYoutubeUiPolicy.REVANCED_PACKAGE, "video", "", "Title", "Channel",
                60_000L, 30_000L, 3, 0L, "strong", "fresh-fingerprint");
        assertTrue(MoaActionBroker.matchesOptionalMediaBinding(new JSONObject(), snapshot));
        assertTrue(MoaActionBroker.matchesOptionalMediaBinding(new JSONObject()
                .put("expected_package", MoaYoutubeUiPolicy.REVANCED_PACKAGE)
                .put("media_fingerprint", "fresh-fingerprint"), snapshot));
        assertFalse(MoaActionBroker.matchesOptionalMediaBinding(new JSONObject()
                .put("media_fingerprint", "stale-fingerprint"), snapshot));
        assertFalse(MoaActionBroker.matchesOptionalMediaBinding(new JSONObject()
                .put("expected_package", MoaYoutubeUiPolicy.OFFICIAL_PACKAGE), snapshot));
        assertFalse(MoaActionBroker.matchesOptionalMediaBinding(new JSONObject()
                .put("media_fingerprint", "fresh-fingerprint"), null));
        assertEquals(15_000L, MoaActionBroker.relativeMediaPosition(
                snapshot.positionMs, -15_000L));
        assertEquals(0L, MoaActionBroker.relativeMediaPosition(5_000L, -15_000L));
    }

    @Test
    public void savedSpotIdsMatchBothLocalAndGatewayIdentity() {
        MoaMediaSpotStore.Spot spot = new MoaMediaSpotStore.Spot(
                "local-id", "Favorite", "", "Title", "youtube", "", "dQw4w9WgXcQ",
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ", 1L, 2L,
                "gateway_synced", 3L, 4L, null, "remote-id");
        assertTrue(MoaActionBroker.mediaSpotMatchesId(spot, "local-id"));
        assertTrue(MoaActionBroker.mediaSpotMatchesId(spot, "remote-id"));
        assertFalse(MoaActionBroker.mediaSpotMatchesId(spot, "unknown"));
    }

    @Test
    public void bookmarkApprovalMaterializesExactVideoAndRequestTimePosition() throws Exception {
        JSONObject args = new JSONObject().put("label", "Favorite");
        MoaActionBroker.materializeBookmarkIdentity(
                args, "dQw4w9WgXcQ", 42_000L, "adapter_extracted");
        assertEquals("dQw4w9WgXcQ", args.getString("video_id"));
        assertEquals(42_000L, args.getLong("position_ms"));
        assertEquals("adapter_extracted", args.getString("_media_identity_provenance"));
        assertTrue(MoaActionBroker.rawVideoIdMatchesCapture(args, "dQw4w9WgXcQ"));
        assertFalse(MoaActionBroker.rawVideoIdMatchesCapture(args, "aaaaaaaaaaa"));
        assertEquals("", MoaActionBroker.canonicalYoutubeVideoId("dQw4w9WgXcQ"));
        assertEquals("dQw4w9WgXcQ", MoaActionBroker.canonicalYoutubeVideoId(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    }

    @Test
    public void explicitGatewayIdNeverFallsThroughToAnotherIdentity() throws Exception {
        JSONObject args = new JSONObject().put("id", "local")
                .put("bookmark_id", "bookmark").put("gateway_bookmark_id", "gateway");
        assertEquals("gateway", MoaActionBroker.bookmarkIdArgument(args));
        MoaMediaSpotStore.Spot remote = new MoaMediaSpotStore.Spot(
                "synced_gateway", "Remote", "", "Remote", "youtube", "",
                "dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                42L, 42L, "gateway_synced", 1L, 1L, null, "gateway");
        MoaActionBroker.materializeRemoteDeleteTarget(args, remote);
        MoaMediaSpotStore.Spot bound = MoaActionBroker.boundRemoteDeleteTarget(args);
        assertEquals("gateway", bound.gatewayBookmarkId);
        assertEquals("dQw4w9WgXcQ", bound.mediaId);
    }

    @Test
    public void bookmarkSyncPayloadKeepsInstalledAppIdentityLocal() throws Exception {
        MoaMediaSpotStore.Spot spot = new MoaMediaSpotStore.Spot(
                "spot-1", "Favorite", "note", "Title", "app.revanced.android.youtube",
                "personal", "dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                42_000L, 300_000L, "canonical_uri", 1L, 1L, null);
        JSONObject payload = MoaActionBroker.mediaSpotSyncPayload(spot);

        assertEquals("youtube", payload.getString("provider"));
        assertFalse(payload.has("preferred_package"));
        assertFalse(payload.has("preferred_instance"));
        assertFalse(payload.has("package"));
        assertFalse(payload.has("signature"));
        assertFalse(payload.has("version"));
        assertFalse(payload.has("gateway_bookmark_id"));
    }

    @Test
    public void exactSearchSelectionDoesNotRequireChannelMetadata() {
        assertTrue(MoaActionBroker.shouldSelectYoutubeSearch("Specific video", true, true, true));
        assertFalse(MoaActionBroker.shouldSelectYoutubeSearch("", true, true, true));
        assertFalse(MoaActionBroker.shouldSelectYoutubeSearch("Specific video", false, true, true));
        assertFalse(MoaActionBroker.shouldSelectYoutubeSearch("Specific video", true, false, true));
    }

    @Test
    public void playlistRenameDisclosureNamesCurrentAndReplacementNames() {
        String disclosure = MoaActionBroker.playlistDisclosure(
                "rename", "Favorites", "Keepers", "app.revanced.android.youtube");
        assertTrue(disclosure.contains("\"Favorites\""));
        assertTrue(disclosure.contains("\"Keepers\""));
    }

    @Test
    public void syncedBookmarkCachesGatewayIdWithoutDevicePackageLinkage() throws Exception {
        MoaMediaSpotStore.Spot spot = MoaActionBroker.syncedSpot(new JSONObject()
                .put("id", "bookmark_123")
                .put("provider", "youtube")
                .put("video_id", "dQw4w9WgXcQ")
                .put("position_ms", 42_000L)
                .put("label", "Browser favorite"));
        assertEquals("bookmark_123", spot.gatewayBookmarkId);
        assertEquals("youtube", spot.packageName);
        assertEquals("", spot.instance);
        assertEquals("gateway_synced", spot.identityStrength);
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
    public void registersBoundedSemanticAccessibilityTools() throws Exception {
        assertTrue(MoaActionBroker.isKnownTool("screen.set_text"));
        assertTrue(MoaActionBroker.isKnownTool("screen.scroll"));
        assertEquals("external_side_effect", MoaActionBroker.capabilityRisk("screen.set_text"));
        assertEquals("local_confirmation", MoaActionBroker.capabilityApproval("screen.set_text"));
        assertEquals("navigation", MoaActionBroker.capabilityRisk("screen.scroll"));
        assertEquals("implicit_user_command", MoaActionBroker.capabilityApproval("screen.scroll"));

        JSONObject input = new JSONObject().put("expected_window_id", 17)
                .put("label", "Message").put("text", "Hello").put("direction", "up");
        assertEquals(17, MoaSemanticAccessibilityActions.expectedWindowId(input));
        assertEquals("Message", MoaSemanticAccessibilityActions.label(input));
        assertEquals("Hello", MoaSemanticAccessibilityActions.text(input));
        assertFalse(MoaSemanticAccessibilityActions.scrollForward(input));
        assertTrue(MoaSemanticAccessibilityActions.scrollForward(new JSONObject().put("direction", "down")));
        assertEquals(null, MoaSemanticAccessibilityActions.scrollForward(
                new JSONObject().put("direction", "sideways")));
    }

    @Test
    public void rejectsOversizedSemanticAccessibilityArguments() throws Exception {
        String longLabel = String.join("", Collections.nCopies(161, "x"));
        String longText = String.join("", Collections.nCopies(4097, "x"));
        assertEquals("", MoaSemanticAccessibilityActions.label(
                new JSONObject().put("label", longLabel)));
        assertEquals(null, MoaSemanticAccessibilityActions.text(
                new JSONObject().put("text", longText)));
        assertEquals("", MoaSemanticAccessibilityActions.text(
                new JSONObject().put("text", "")));
        assertEquals(null, MoaSemanticAccessibilityActions.text(new JSONObject()));
        assertTrue(MoaSemanticAccessibilityActions.sensitiveLabel("Password"));
        assertTrue(MoaSemanticAccessibilityActions.sensitiveLabel("Card security code"));
        assertTrue(MoaSemanticAccessibilityActions.sensitiveLabel("Enter PIN"));
        assertFalse(MoaSemanticAccessibilityActions.sensitiveLabel("Message"));
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

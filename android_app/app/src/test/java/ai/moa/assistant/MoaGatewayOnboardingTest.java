package ai.moa.assistant;

import org.junit.Test;

import java.net.SocketTimeoutException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaGatewayOnboardingTest {
    @Test
    public void preferredYoutubeDefaultsToRevancedAndRejectsMalformedPackages() {
        assertEquals("app.revanced.android.youtube", MoaPrefs.DEFAULT_YOUTUBE_PACKAGE);
        assertEquals("app.revanced.android.youtube", MoaPrefs.preferredYoutubePackageValue("youtube"));
        assertEquals("com.google.android.youtube", MoaPrefs.preferredYoutubePackageValue(
                " com.google.android.youtube "));
    }

    @Test
    public void youtubeFixtureBindsPackageVersionAndSignerExactly() {
        String signer = "a".repeat(64);
        MoaPrefs.YoutubePackageFixture fixture = new MoaPrefs.YoutubePackageFixture(
                "app.revanced.android.youtube", 123L, signer);
        assertTrue(fixture.matches("app.revanced.android.youtube", 123L, signer));
        assertFalse(fixture.matches("com.google.android.youtube", 123L, signer));
        assertFalse(fixture.matches("app.revanced.android.youtube", 124L, signer));
        assertFalse(fixture.matches("app.revanced.android.youtube", 123L, "b".repeat(64)));
    }

    @Test
    public void defaultGatewayUsesHostedOrigin() {
        assertEquals("https://api.agee.app", MoaPrefs.DEFAULT_GATEWAY_URL);
        assertEquals("wss://api.agee.app/v1/voice/sessions", MoaVoiceGatewaySocket.DEFAULT_URL);
    }

    @Test
    public void tokenlessStaleDefaultMigratesToHostedOrigin() {
        assertEquals(
                MoaPrefs.DEFAULT_GATEWAY_URL,
                MoaPrefs.gatewayUrlAfterStaleDefaultMigration(" http://10.147.17.10:8787/ ", "")
        );
    }

    @Test
    public void staleDefaultWithTokenIsLeftAlone() {
        assertEquals(
                "http://10.147.17.10:8787",
                MoaPrefs.gatewayUrlAfterStaleDefaultMigration("http://10.147.17.10:8787", "device-token")
        );
    }

    @Test
    public void localDevUrlIsClassifiedButNotAutoMigrated() {
        assertEquals(MoaPrefs.GatewayUrlIssue.LOCAL_DEV, MoaPrefs.classifyGatewayUrl(MoaPrefs.LOCAL_DEV_GATEWAY_URL));
        assertEquals(
                MoaPrefs.LOCAL_DEV_GATEWAY_URL,
                MoaPrefs.gatewayUrlAfterStaleDefaultMigration(MoaPrefs.LOCAL_DEV_GATEWAY_URL, "")
        );
    }

    @Test
    public void httpEndpointPathIsClassifiedAsOriginMistake() {
        assertEquals(
                MoaPrefs.GatewayUrlIssue.ENDPOINT_PATH,
                MoaPrefs.classifyGatewayUrl("https://api.agee.app/v1/voice/sessions")
        );
    }

    @Test
    public void generatedWssSocketPathIsNotAnOriginMistake() {
        assertEquals(
                MoaPrefs.GatewayUrlIssue.NONE,
                MoaPrefs.classifyGatewayUrl("wss://api.agee.app/v1/voice/sessions")
        );
    }

    @Test
    public void voiceSocketDerivesHostedWssUrl() {
        assertEquals(
                "wss://api.agee.app/v1/voice/sessions",
                MoaVoiceGatewaySocket.voiceSocketUrl("https://api.agee.app")
        );
    }

    @Test
    public void voiceTimeoutMentionsStableVpsAndSameNetwork() {
        String message = MoaVoiceGatewaySocket.socketFailureMessage(
                "https://api.example.com",
                "wss://api.example.com/v1/voice/sessions",
                new SocketTimeoutException("timeout"),
                null
        );

        assertTrue(message.contains("stable VPS URL"));
        assertTrue(message.contains("same network/VPN"));
    }

    @Test
    public void staleMainMachineVoiceFailureUsesSpecificGuidance() {
        String message = MoaVoiceGatewaySocket.socketFailureMessage(
                "http://10.147.17.10:8787",
                "ws://10.147.17.10:8787/v1/voice/sessions",
                new SocketTimeoutException("timeout"),
                null
        );

        assertTrue(message.contains("old main-machine ZeroTier gateway"));
        assertTrue(message.contains(MoaPrefs.ONBOARDING_GATEWAY_URL));
    }

    @Test
    public void missingSchemeVoiceFailureRequestsFullGatewayUrl() {
        String message = MoaVoiceGatewaySocket.socketFailureMessage(
                "api.agee.app",
                "api.agee.app/v1/voice/sessions",
                new IllegalArgumentException("Expected URL scheme"),
                null
        );

        assertTrue(message.contains("Enter the full gateway URL"));
        assertTrue(message.contains(MoaPrefs.ONBOARDING_GATEWAY_URL));
    }
}

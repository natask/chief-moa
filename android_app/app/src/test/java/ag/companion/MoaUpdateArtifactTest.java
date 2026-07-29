package ag.companion;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;

/**
 * The device-independent half of update-artifact handling.
 *
 * Hashing and endpoint joining decide whether a downloaded APK is the one the
 * manifest promised, so they are worth pinning without an emulator.
 */
public final class MoaUpdateArtifactTest {

    @Test
    public void sha256HexMatchesTheKnownDigestOfTheContent() throws Exception {
        File file = File.createTempFile("ota-artifact", ".bin");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write("abc".getBytes(StandardCharsets.UTF_8));
        }

        // The published SHA-256 of "abc".
        assertEquals(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                MoaUpdateArtifact.sha256Hex(file));

        Files.deleteIfExists(file.toPath());
    }

    @Test
    public void sha256HexIsLowercaseAndFullLengthForEmptyContent() throws Exception {
        File file = File.createTempFile("ota-empty", ".bin");

        // An empty artifact must still produce a full digest rather than "",
        // so a truncated download can never accidentally compare equal.
        assertEquals(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                MoaUpdateArtifact.sha256Hex(file));

        Files.deleteIfExists(file.toPath());
    }

    @Test
    public void gatewayEndpointJoinsWithoutDoublingTheSeparator() {
        assertEquals("https://api.example.test/health",
                MoaUpdateArtifact.gatewayEndpoint("https://api.example.test", "/health"));
        assertEquals("https://api.example.test/health",
                MoaUpdateArtifact.gatewayEndpoint("https://api.example.test/", "/health"));
        assertEquals("https://api.example.test/health",
                MoaUpdateArtifact.gatewayEndpoint("https://api.example.test///", "/health"));
    }

    @Test
    public void gatewayEndpointTrimsSurroundingWhitespace() {
        assertEquals("https://api.example.test/v1/sessions",
                MoaUpdateArtifact.gatewayEndpoint("  https://api.example.test  ", "/v1/sessions"));
    }

    @Test
    public void gatewayEndpointTreatsAnAbsentGatewayAsAnEmptyOrigin() {
        // A null gateway must yield the bare path rather than "null/health",
        // which would otherwise be requested verbatim and fail confusingly.
        assertEquals("/health", MoaUpdateArtifact.gatewayEndpoint(null, "/health"));
        assertEquals("/health", MoaUpdateArtifact.gatewayEndpoint("", "/health"));
    }
}

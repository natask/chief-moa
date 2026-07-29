package ag.companion;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public final class MoaVlcOpenPolicyTest {
    @Test public void acceptsOnlyExplicitHttpsOrContentSources() {
        assertFalse(MoaVlcOpenPolicy.validatedSource("https://media.example/song.mp3").isEmpty());
        assertFalse(MoaVlcOpenPolicy.validatedSource("content://media/external/audio/42").isEmpty());
        assertTrue(MoaVlcOpenPolicy.validatedSource("http://media.example/song.mp3").isEmpty());
        assertTrue(MoaVlcOpenPolicy.validatedSource("file:///sdcard/song.mp3").isEmpty());
        assertTrue(MoaVlcOpenPolicy.validatedSource("/sdcard/song.mp3").isEmpty());
        assertTrue(MoaVlcOpenPolicy.validatedSource("intent:#Intent;package=org.videolan.vlc;end").isEmpty());
    }
    @Test public void visibleVlcLabelsAreBoundedAndPackageNamesAreNotLabels() {
        assertTrue(MoaVlcOpenPolicy.isVlcLabel("VLC"));
        assertTrue(MoaVlcOpenPolicy.isVlcLabel("VLC for Android"));
        assertFalse(MoaVlcOpenPolicy.isVlcLabel("org.videolan.vlc"));
    }
    @Test public void titleOnlyRequestReportsNeedsSource() throws Exception {
        MoaVlcOpenPolicy.Result result = MoaVlcOpenPolicy.resolve(new JSONObject()
                .put("app_name", "VLC").put("title", "Blue in Green"), null);
        assertEquals(MoaVlcOpenPolicy.Status.NEEDS_SOURCE, result.status);
        assertEquals("needs_source", result.reason);
    }
    @Test public void rawPackageAndUnknownSelectorsAreRejected() throws Exception {
        assertEquals(MoaVlcOpenPolicy.Status.REJECTED, MoaVlcOpenPolicy.resolve(new JSONObject()
                .put("app_name", "VLC").put("package", "org.videolan.vlc")
                .put("url", "https://media.example/song.mp3"), null).status);
        assertEquals(MoaVlcOpenPolicy.Status.REJECTED, MoaVlcOpenPolicy.resolve(new JSONObject()
                .put("app_name", "org.videolan.vlc").put("url", "https://media.example/song.mp3"), null).status);
    }
}

package ag.companion;

import android.media.session.PlaybackState;
import android.text.InputType;
import org.junit.Test;
import java.util.Collections;
import static org.junit.Assert.assertEquals;

public final class MoaAccessibilityServiceTest {
    @Test public void sensitiveEditableTypesFailClosed() {
        assertEquals(true, MoaAccessibilityService.isSensitiveTextInput(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false));
        assertEquals(true, MoaAccessibilityService.isSensitiveTextInput(
                InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD, false));
        assertEquals(true, MoaAccessibilityService.isSensitiveTextInput(
                InputType.TYPE_CLASS_TEXT, true));
        assertEquals(false, MoaAccessibilityService.isSensitiveTextInput(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, false));
    }
    @Test public void realSnapshotProjectionCarriesOnlyMatchingStrongSessionIdentity() {
        String pkg = MoaYoutubeUiPolicy.REVANCED_PACKAGE;
        MoaMediaSessionController.Snapshot media = new MoaMediaSessionController.Snapshot(
                pkg, "dQw4w9WgXcQ", "", "Observed title", "Channel", 100_000L, 12_000L,
                PlaybackState.STATE_PLAYING, PlaybackState.ACTION_PLAY, "strong", "fingerprint");
        MoaYoutubeAccessibilityExecutor.Snapshot bound = MoaAccessibilityService.youtubeSnapshot(
                pkg, 7, Collections.emptyList(), media);
        assertEquals("dQw4w9WgXcQ", bound.mediaVideoId);
        assertEquals("Observed title", bound.mediaTitle);
        assertEquals("fingerprint", bound.mediaFingerprint);

        MoaYoutubeAccessibilityExecutor.Snapshot mismatch = MoaAccessibilityService.youtubeSnapshot(
                MoaYoutubeUiPolicy.OFFICIAL_PACKAGE, 7, Collections.emptyList(), media);
        assertEquals("", mismatch.mediaVideoId);
        assertEquals("", mismatch.mediaFingerprint);
    }
}

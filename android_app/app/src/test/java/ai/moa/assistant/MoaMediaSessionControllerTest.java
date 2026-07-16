package ai.moa.assistant;

import android.media.session.PlaybackState;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public final class MoaMediaSessionControllerTest {
    @Test
    public void recognizesOfficialAndDynamicallyPackagedYouTubeSessions() {
        assertTrue(MoaMediaSessionController.isYouTubeLikePackage("com.google.android.youtube"));
        assertTrue(MoaMediaSessionController.isYouTubeLikePackage("app.revanced.android.youtube"));
        assertTrue(MoaMediaSessionController.isYouTubeLikePackage("org.example.YouTubeMusic"));
        assertFalse(MoaMediaSessionController.isYouTubeLikePackage("com.google.android.apps.maps"));
        assertFalse(MoaMediaSessionController.isYouTubeLikePackage(""));
    }

    @Test
    public void packageBindingIsExactAndCaseInsensitive() {
        assertTrue(MoaMediaSessionController.packageMatches(
                "app.revanced.android.youtube", "APP.REVANCED.ANDROID.YOUTUBE"));
        assertFalse(MoaMediaSessionController.packageMatches(
                "app.revanced.android.youtube", "com.google.android.youtube"));
        assertFalse(MoaMediaSessionController.packageMatches("", "com.google.android.youtube"));
    }

    @Test
    public void requiresEveryAdvertisedActionBit() {
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE;
        assertTrue(MoaMediaSessionController.isActionAdvertised(actions, PlaybackState.ACTION_PLAY));
        assertTrue(MoaMediaSessionController.isActionAdvertised(
                actions, PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE));
        assertFalse(MoaMediaSessionController.isActionAdvertised(actions, PlaybackState.ACTION_SEEK_TO));
        assertFalse(MoaMediaSessionController.isActionAdvertised(actions, 0L));
    }

    @Test
    public void stopRequiresAdvertisedStopAction() {
        long withoutStop = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE;
        long withStop = withoutStop | PlaybackState.ACTION_STOP;

        assertFalse(MoaMediaSessionController.isActionAdvertised(
                withoutStop, PlaybackState.ACTION_STOP));
        assertTrue(MoaMediaSessionController.isActionAdvertised(
                withStop, PlaybackState.ACTION_STOP));
    }

    @Test
    public void titleOnlyIdentityRemainsWeakForBookmarkCallers() {
        assertEquals("strong", MoaMediaSessionController.identityStrength("video-id", "", "Title"));
        assertEquals("strong", MoaMediaSessionController.identityStrength(
                "", "https://youtu.be/video-id", "Title"));
        assertEquals("weak", MoaMediaSessionController.identityStrength("", "", "Title"));
        assertEquals("unavailable", MoaMediaSessionController.identityStrength("", "", ""));
    }

    @Test
    public void extrapolatesOnlyAdvancingPlaybackAndClampsToDuration() {
        assertEquals(12_000L, MoaMediaSessionController.extrapolatePosition(
                10_000L, 2_000L, 4_000L, 1.0f, true, 30_000L));
        assertEquals(10_000L, MoaMediaSessionController.extrapolatePosition(
                10_000L, 2_000L, 4_000L, 1.0f, false, 30_000L));
        assertEquals(30_000L, MoaMediaSessionController.extrapolatePosition(
                29_000L, 2_000L, 4_000L, 2.0f, true, 30_000L));
        assertEquals(0L, MoaMediaSessionController.extrapolatePosition(
                -1L, 2_000L, 4_000L, 1.0f, false, 30_000L));
    }

    @Test
    public void seekClampIsBoundedWithAndWithoutKnownDuration() {
        assertEquals(0L, MoaMediaSessionController.clampPosition(-100L, 50_000L));
        assertEquals(25_000L, MoaMediaSessionController.clampPosition(25_000L, 50_000L));
        assertEquals(50_000L, MoaMediaSessionController.clampPosition(80_000L, 50_000L));
        assertEquals(MoaMediaSessionController.MAX_MEDIA_TIME_MS,
                MoaMediaSessionController.clampPosition(Long.MAX_VALUE, 0L));
        assertEquals(15_000L, MoaMediaSessionController.relativePosition(
                30_000L, -15_000L, 60_000L));
        assertEquals(0L, MoaMediaSessionController.relativePosition(
                5_000L, -15_000L, 60_000L));
        assertEquals(60_000L, MoaMediaSessionController.relativePosition(
                55_000L, 15_000L, 60_000L));
        assertTrue(MoaMediaSessionController.positionWithinTolerance(30_000L, 31_500L, 2_000L));
        assertFalse(MoaMediaSessionController.positionWithinTolerance(30_000L, 33_000L, 2_000L));
    }

    @Test
    public void fingerprintBindsPackageAndStableMediaIdentity() {
        String first = MoaMediaSessionController.mediaFingerprint(
                "app.revanced.android.youtube", "video-1", "", "Title A", "Channel", 60_000L);
        String renamed = MoaMediaSessionController.mediaFingerprint(
                "app.revanced.android.youtube", "video-1", "", "Title B", "Channel", 60_000L);
        String otherVideo = MoaMediaSessionController.mediaFingerprint(
                "app.revanced.android.youtube", "video-2", "", "Title A", "Channel", 60_000L);
        String otherPackage = MoaMediaSessionController.mediaFingerprint(
                "com.google.android.youtube", "video-1", "", "Title A", "Channel", 60_000L);

        assertEquals(first, renamed);
        assertNotEquals(first, otherVideo);
        assertNotEquals(first, otherPackage);
        assertEquals(64, first.length());
    }

    @Test
    public void validatesOnlyYouTubeHttpsUris() {
        assertEquals("https://youtu.be/abc?t=30",
                MoaMediaSessionController.validatedYouTubeHttpsUri("https://youtu.be/abc?t=30"));
        assertEquals("https://music.youtube.com/watch?v=abc",
                MoaMediaSessionController.validatedYouTubeHttpsUri(
                        "https://music.youtube.com/watch?v=abc"));
        assertEquals("", MoaMediaSessionController.validatedYouTubeHttpsUri(
                "http://youtube.com/watch?v=abc"));
        assertEquals("", MoaMediaSessionController.validatedYouTubeHttpsUri(
                "https://youtube.com.evil.example/watch?v=abc"));
        assertEquals("", MoaMediaSessionController.validatedYouTubeHttpsUri(
                "javascript:alert(1)"));
    }
}

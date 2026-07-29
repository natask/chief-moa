package ai.moa.assistant;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class MoaVideoNoteStateTest {
    private static final String SHA = "a".repeat(64);

    @Test
    public void requestDoesNotClaimCaptureAndCanBeCancelled() {
        MoaVideoNoteState requested = MoaVideoNoteState.idle().request(binding("release-1"));
        assertEquals(MoaVideoNoteState.Phase.REQUESTED, requested.phase);
        assertFalse(requested.mayAttach());
        assertEquals(MoaVideoNoteState.Phase.CANCELLED, requested.cancel().phase);
    }

    @Test
    public void capturedDescriptorRequiresMatchingReceiptAndRelease() {
        MoaVideoNoteState capturing = MoaVideoNoteState.idle().request(binding("release-1"))
                .captureStarted("capture-receipt-1");
        MoaVideoNoteState.Descriptor descriptor = new MoaVideoNoteState.Descriptor(
                "video-note://note-1", SHA, 20_000L, 1_000L, "video/mp4",
                "delete_after_submission", "capture-receipt-1", binding("release-1"));
        assertTrue(capturing.captured(descriptor).mayAttach());

        try {
            capturing.captured(new MoaVideoNoteState.Descriptor(
                    "video-note://note-2", SHA, 20_000L, 1_000L, "video/mp4",
                    "delete_after_submission", "capture-receipt-1", binding("release-2")));
        } catch (IllegalStateException expected) {
            return;
        }
        throw new AssertionError("Expected exact release mismatch rejection");
    }

    @Test
    public void descriptorSerializesTypedExactBinding() throws Exception {
        MoaVideoNoteState.Descriptor descriptor = new MoaVideoNoteState.Descriptor(
                "video-note://note-1", SHA, 1_000L, 2_000L, "video/mp4",
                "keep_7_days", "receipt-1", binding("release-1"));
        assertEquals("video_note", descriptor.toJson().getString("type"));
        assertEquals("release-1", descriptor.toJson().getJSONObject("release_binding")
                .getString("release_id"));
    }

    @Test
    public void videoBoundsFailClosed() {
        try {
            new MoaVideoNoteState.Descriptor("video-note://note-1", SHA,
                    MoaVideoNoteState.MAX_DURATION_MS + 1L, 1L, "video/mp4",
                    "keep_7_days", "receipt-1", binding("release-1"));
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("Expected duration bound rejection");
    }

    private static MoaVideoNoteState.Binding binding(String release) {
        return new MoaVideoNoteState.Binding("assignment-1", release, "bundle-1", SHA);
    }
}

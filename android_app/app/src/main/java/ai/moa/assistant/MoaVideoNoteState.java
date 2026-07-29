package ai.moa.assistant;

import org.json.JSONObject;

import java.util.Locale;

/** Evidence-only video-note lifecycle. Capture/upload claims require receipts. */
final class MoaVideoNoteState {
    static final long MAX_DURATION_MS = 120_000L;
    static final long MAX_SIZE_BYTES = 50L * 1024L * 1024L;
    private static final String ID = "[A-Za-z0-9._:-]{1,160}";
    private static final String SHA256 = "[a-f0-9]{64}";

    enum Phase { IDLE, REQUESTED, CAPTURING, CAPTURED, CANCELLED, FAILED }

    static final class Binding {
        final String assignmentId;
        final String releaseId;
        final String bundleId;
        final String artifactSha256;

        Binding(String assignmentId, String releaseId, String bundleId, String artifactSha256) {
            this.assignmentId = requireId(assignmentId);
            this.releaseId = requireId(releaseId);
            this.bundleId = requireId(bundleId);
            this.artifactSha256 = requireSha(artifactSha256);
        }
    }

    static final class Descriptor {
        final String ref;
        final String sha256;
        final long durationMs;
        final long sizeBytes;
        final String mimeType;
        final String retention;
        final String captureReceiptId;
        final Binding binding;

        Descriptor(String ref, String sha256, long durationMs, long sizeBytes, String mimeType,
                   String retention, String captureReceiptId, Binding binding) {
            if (ref == null || !ref.matches("video-note://" + ID)) {
                throw new IllegalArgumentException("video note ref is invalid");
            }
            this.ref = ref;
            this.sha256 = requireSha(sha256);
            if (durationMs < 1L || durationMs > MAX_DURATION_MS) {
                throw new IllegalArgumentException("video note duration exceeds bounds");
            }
            if (sizeBytes < 1L || sizeBytes > MAX_SIZE_BYTES) {
                throw new IllegalArgumentException("video note size exceeds bounds");
            }
            if (!"video/mp4".equals(mimeType)) throw new IllegalArgumentException("video note MIME is unsupported");
            if (!"delete_after_submission".equals(retention) && !"keep_7_days".equals(retention)) {
                throw new IllegalArgumentException("video note retention is unsupported");
            }
            this.durationMs = durationMs;
            this.sizeBytes = sizeBytes;
            this.mimeType = mimeType;
            this.retention = retention;
            this.captureReceiptId = requireId(captureReceiptId);
            if (binding == null) throw new IllegalArgumentException("video note release binding is required");
            this.binding = binding;
        }

        JSONObject toJson() throws Exception {
            return new JSONObject()
                    .put("type", "video_note")
                    .put("ref", ref)
                    .put("sha256", sha256)
                    .put("duration_ms", durationMs)
                    .put("size_bytes", sizeBytes)
                    .put("mime_type", mimeType)
                    .put("retention", retention)
                    .put("capture_receipt_id", captureReceiptId)
                    .put("release_binding", new JSONObject()
                            .put("surface", "android")
                            .put("assignment_id", binding.assignmentId)
                            .put("release_id", binding.releaseId)
                            .put("bundle_id", binding.bundleId)
                            .put("artifact_sha256", binding.artifactSha256));
        }
    }

    final Phase phase;
    final Binding binding;
    final Descriptor descriptor;
    final String receiptId;

    private MoaVideoNoteState(Phase phase, Binding binding, Descriptor descriptor, String receiptId) {
        this.phase = phase;
        this.binding = binding;
        this.descriptor = descriptor;
        this.receiptId = receiptId == null ? "" : receiptId;
    }

    static MoaVideoNoteState idle() { return new MoaVideoNoteState(Phase.IDLE, null, null, ""); }

    MoaVideoNoteState request(Binding exactBinding) {
        if (phase != Phase.IDLE && phase != Phase.CANCELLED && phase != Phase.FAILED) {
            throw new IllegalStateException("video note request is already active");
        }
        return new MoaVideoNoteState(Phase.REQUESTED, exactBinding, null, "");
    }

    MoaVideoNoteState captureStarted(String captureReceiptId) {
        if (phase != Phase.REQUESTED) throw new IllegalStateException("video note was not requested");
        return new MoaVideoNoteState(Phase.CAPTURING, binding, null, requireId(captureReceiptId));
    }

    MoaVideoNoteState captured(Descriptor value) {
        if (phase != Phase.CAPTURING || value == null || !sameBinding(binding, value.binding)
                || !receiptId.equals(value.captureReceiptId)) {
            throw new IllegalStateException("video capture descriptor lacks a matching receipt");
        }
        return new MoaVideoNoteState(Phase.CAPTURED, binding, value, receiptId);
    }

    MoaVideoNoteState cancel() {
        if (phase != Phase.REQUESTED && phase != Phase.CAPTURING) {
            throw new IllegalStateException("video note is not cancellable");
        }
        return new MoaVideoNoteState(Phase.CANCELLED, binding, null, receiptId);
    }

    boolean mayAttach() { return phase == Phase.CAPTURED && descriptor != null; }

    private static boolean sameBinding(Binding left, Binding right) {
        return left.assignmentId.equals(right.assignmentId) && left.releaseId.equals(right.releaseId)
                && left.bundleId.equals(right.bundleId)
                && left.artifactSha256.equals(right.artifactSha256);
    }

    private static String requireId(String value) {
        String id = value == null ? "" : value;
        if (!id.matches(ID)) throw new IllegalArgumentException("video note identity is invalid");
        return id;
    }

    private static String requireSha(String value) {
        String sha = value == null ? "" : value.toLowerCase(Locale.US);
        if (!sha.matches(SHA256)) throw new IllegalArgumentException("video note digest is invalid");
        return sha;
    }
}

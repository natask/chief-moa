package ai.moa.assistant;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Atomic request-finalization sequence for callback-time Ask state.
 * A failed semantic binding also invalidates the associated pixels.
 */
final class MoaScreenAwareAskFinalizer {
    private MoaScreenAwareAskFinalizer() {
    }

    static Result captured(
            JSONObject requestBody,
            JSONObject refreshedSnapshot,
            MoaScreenshotCapture capture
    ) throws JSONException {
        boolean bound = MoaScreenContextReleasePolicy.applyCapturedContext(
                requestBody,
                refreshedSnapshot,
                capture
        );
        if (!bound) {
            return Result.withoutContext();
        }
        MoaScreenEvidenceEnvelope.attachToAsk(
                requestBody,
                capture,
                refreshedSnapshot.optString("summary", "")
        );
        return Result.withCapture();
    }

    static Result denied(
            JSONObject requestBody,
            JSONObject refreshedSnapshot,
            String expectedPackage,
            long nowMs,
            MoaScreenshotPolicy.DenialReason reason
    ) throws JSONException {
        boolean semantic = MoaScreenContextReleasePolicy.applyDeniedContext(
                requestBody,
                refreshedSnapshot,
                expectedPackage,
                nowMs,
                reason
        );
        return semantic ? Result.withSemanticOnly() : Result.withoutContext();
    }

    static final class Result {
        final boolean screenshotAttached;
        final boolean semanticContextAttached;

        private Result(boolean screenshotAttached, boolean semanticContextAttached) {
            this.screenshotAttached = screenshotAttached;
            this.semanticContextAttached = semanticContextAttached;
        }

        private static Result withCapture() {
            return new Result(true, true);
        }

        private static Result withSemanticOnly() {
            return new Result(false, true);
        }

        private static Result withoutContext() {
            return new Result(false, false);
        }
    }
}

package ai.moa.assistant;

import org.json.JSONObject;

/**
 * Normalized result passed from Android-local tool adapters to durable receipt
 * handling.
 */
final class MoaToolRequestExecution {
    final boolean success;
    final String summary;
    final JSONObject receipt;

    MoaToolRequestExecution(boolean success, String summary, JSONObject receipt) {
        this.success = success;
        this.summary = summary == null ? "" : summary.trim();
        this.receipt = receipt;
    }
}

package ag.companion;

import android.content.Context;

/**
 * First-run settings restore for a clean {@code ag.companion} install.
 *
 * <p>Reads the account's settings with the device's own scoped credential and
 * applies them locally. Reports exactly what happened — restored, partly
 * restored, or not restored — and never claims an outcome it did not observe. A
 * failed read leaves the stored settings alone; enrollment itself still
 * stands.</p>
 */
final class AgContinuityRestore {
    private AgContinuityRestore() {
    }

    static String restoreAndSummarize(Context context, AgEnrollmentClient client,
            MoaDeviceCredentialStore store, String deviceId) {
        MoaDeviceCredentialStore.EnrollmentCredential credential = store.loadEnrollmentCredential(
                MoaPrefs.gatewayUrl(context), deviceId);
        if (credential == null) {
            return "Settings were not restored: no verified device credential.";
        }
        try {
            AgSettingsRestore.Result restore = MoaPrefs.restoreAccountSettings(
                    context, client.readSettings(credential.token));
            if (!restore.restored()) {
                return restore.note;
            }
            String applied = "Restored " + restore.appliedFields.size() + " account settings.";
            return restore.note.isEmpty() ? applied : applied + " " + restore.note;
        } catch (Exception error) {
            return "Settings were not restored: " + shortReason(error) + ".";
        }
    }

    private static String shortReason(Exception error) {
        String message = error == null ? "unknown error" : String.valueOf(error.getMessage()).trim();
        if (message.isEmpty()) {
            return "unknown error";
        }
        return message.length() <= 160 ? message : message.substring(0, 160);
    }
}

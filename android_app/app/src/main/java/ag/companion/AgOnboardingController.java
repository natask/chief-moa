package ag.companion;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Owns the bounded, live-state-driven first-launch onboarding presentation. */
final class AgOnboardingController {
    private static final int REQUEST_AUDIO = 4101;
    private static final int REQUEST_NOTIFICATIONS = 4103;
    private final MainActivity activity;

    AgOnboardingController(MainActivity activity) {
        this.activity = activity;
    }

    View createView() {
        LinearLayout card = activity.card();
        activity.addCardTitle(card, "Set up Ag together");
        activity.addHint(card,
                "Start with one real conversation. Ag only asks for access when you choose a step.");

        boolean connected = activity.verifiedEnrollment() != null;
        boolean microphone = activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        boolean firstConversation = MoaPrefs.firstConversationCompleted(activity);
        boolean notifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        AgOnboardingState.Capability next = new AgOnboardingState(null).nextRequired(
                new AgOnboardingState.LiveState(
                        connected, microphone, firstConversation, notifications));

        row(card, "1. Connect", connected, connected
                ? "Authenticated continuity verified" : "Use a short-lived enrollment code below");
        row(card, "2. Microphone", microphone, microphone
                ? "Android permission verified" : "Requested only when you tap Enable microphone");
        row(card, "3. First conversation", firstConversation, firstConversation
                ? "A completed gateway turn was verified"
                : "Talk to Ag after connection and microphone are ready");
        row(card, "4. Notifications", notifications, notifications
                ? "Android notification access verified"
                : "Optional for continuity; enable when you are ready");

        if (next == AgOnboardingState.Capability.MICROPHONE) {
            Button enable = activity.primaryButton("Enable microphone");
            enable.setOnClickListener(v -> activity.requestPermissions(
                    new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO));
            card.addView(enable);
        } else if (next == AgOnboardingState.Capability.FIRST_CONVERSATION) {
            activity.addHint(card, "Open the Ag companion, speak once, and wait for the reply. "
                    + "This step completes only after the gateway reports a completed turn.");
        } else if (next == AgOnboardingState.Capability.NOTIFICATIONS
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Button enable = activity.primaryButton("Enable notifications");
            enable.setOnClickListener(v -> activity.requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS));
            card.addView(enable);
        } else if (next == null) {
            activity.addHint(card, "Core setup is complete. Overlay, screen access, media control, "
                    + "contacts, and updates remain optional below.");
        }
        return card;
    }

    private void row(LinearLayout card, String title, boolean verified, String detail) {
        TextView row = activity.label((verified ? "✓ " : "○ ") + title + " — " + detail,
                verified ? MoaColors.OK : MoaColors.MUTED, 13, false);
        row.setPadding(0, activity.dp(6), 0, activity.dp(2));
        card.addView(row);
    }
}

package ai.moa.assistant;

import android.content.Context;
import android.widget.TextView;

import java.util.function.Consumer;

final class MoaVoiceDeliveryToggle {
    private MoaVoiceDeliveryToggle() {
    }

    static void bind(Context context, TextView toggle, Consumer<Boolean> onChange) {
        update(toggle, MoaPrefs.spokenRepliesEnabled(context));
        toggle.setContentDescription("Toggle spoken replies");
        toggle.setOnClickListener(view -> {
            boolean enabled = !MoaPrefs.spokenRepliesEnabled(context);
            MoaPrefs.setSpokenRepliesEnabled(context, enabled);
            onChange.accept(enabled);
            update(toggle, enabled);
        });
    }

    private static void update(TextView toggle, boolean enabled) {
        toggle.setText(enabled ? "Voice" : "Text");
        toggle.setTextColor(enabled ? MoaColors.GOLD : MoaColors.PAPER);
    }
}

package ag.companion;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/** Full-app provider profile selector. Provider credentials remain gateway-owned. */
final class MoaProviderSettingsView {
    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final LinearLayout card;
    private final LinearLayout choices;
    private final TextView status;
    private final Button refresh;
    private int generation;
    private MoaProviderCatalog catalog;

    private MoaProviderSettingsView(Context context) {
        this.context = context;
        card = card(context);
        card.addView(text("AI provider", MoaColors.PAPER, 18, true));
        TextView detail = text(
                "Choose a gateway-configured voice and reasoning profile. Provider accounts and credentials stay on the gateway.",
                MoaColors.MUTED, 13, false);
        detail.setPadding(0, dp(6), 0, dp(10));
        card.addView(detail);
        status = text("Loading gateway choices…", MoaColors.GOLD, 13, true);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setPadding(0, 0, 0, dp(8));
        card.addView(status);
        choices = new LinearLayout(context);
        choices.setOrientation(LinearLayout.VERTICAL);
        card.addView(choices);
        refresh = button("Refresh provider choices");
        refresh.setOnClickListener(ignored -> load());
        card.addView(refresh);
        load();
    }

    static View create(Context context) {
        return new MoaProviderSettingsView(context).card;
    }

    private void load() {
        int request = ++generation;
        setBusy("Loading gateway choices…");
        String gatewayUrl = MoaPrefs.gatewayUrl(context);
        if (gatewayUrl == null || gatewayUrl.trim().isEmpty()) {
            showError(request, "Connect the gateway to choose a provider.");
            return;
        }
        new Thread(() -> {
            try {
                String deviceId = androidDeviceId();
                MoaGatewayClient client = new MoaGatewayClient(gatewayUrl, MoaPrefs.gatewayToken(context));
                JSONObject catalogPayload = client.providerCatalog("device", deviceId);
                JSONObject profilePayload = client.agentProfile("device", deviceId);
                MoaProviderCatalog next = MoaProviderCatalog.parse(catalogPayload, profilePayload);
                mainHandler.post(() -> render(request, next));
            } catch (Exception error) {
                mainHandler.post(() -> showError(request, readableError(error)));
            }
        }, "moa-provider-catalog").start();
    }

    private void render(int request, MoaProviderCatalog next) {
        if (request != generation) return;
        catalog = next;
        choices.removeAllViews();
        if (next.choices.isEmpty()) {
            showError(request, "The gateway returned no provider choices.");
            return;
        }
        status.setText(next.profileVersion.isEmpty()
                ? "Gateway provider catalog" : "Profile version " + next.profileVersion);
        status.setTextColor(MoaColors.OK);
        for (MoaProviderCatalog.Choice choice : next.choices) choices.addView(choiceRow(choice));
        refresh.setEnabled(true);
        refresh.setAlpha(1f);
    }

    private View choiceRow(MoaProviderCatalog.Choice choice) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        row.setBackground(MoaDrawables.rounded(
                0x14FFFFFF, dp(14), choice.active ? MoaColors.GOLD : MoaColors.RAISED_BORDER, dp(1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        row.setLayoutParams(params);

        TextView label = text(choice.label, MoaColors.PAPER, 15, true);
        row.addView(label);
        TextView explanation = text(choice.statusText(),
                choice.configured ? MoaColors.OK : MoaColors.WARN, 12, false);
        explanation.setPadding(0, dp(3), 0, dp(6));
        row.addView(explanation);

        Button use = button(choice.active ? "Active" : "Use " + choice.label);
        use.setEnabled(choice.configured && !choice.active);
        use.setAlpha(use.isEnabled() ? 1f : 0.6f);
        use.setContentDescription(choice.active
                ? choice.label + ", active provider"
                : choice.configured
                        ? "Use " + choice.label + " provider profile"
                        : choice.label + ", unavailable. " + choice.statusText());
        use.setOnClickListener(ignored -> confirm(choice));
        row.addView(use);
        return row;
    }

    private void confirm(MoaProviderCatalog.Choice choice) {
        new AlertDialog.Builder(context)
                .setTitle("Use " + choice.label + "?")
                .setMessage("Ag will create a new device profile version on the gateway. New voice turns will use that confirmed profile.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Use provider", (dialog, which) -> select(choice))
                .show();
    }

    private void select(MoaProviderCatalog.Choice choice) {
        int request = ++generation;
        setBusy("Creating a new gateway profile version…");
        String oldVersion = catalog == null ? "" : catalog.profileVersion;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("scope", "device")
                        .put("device_id", androidDeviceId())
                        .put("choice_id", choice.id)
                        .put("source", "android_provider_selector");
                if (!choice.modelId.isEmpty()) body.put("model_id", choice.modelId);
                JSONObject response = new MoaGatewayClient(
                        MoaPrefs.gatewayUrl(context), MoaPrefs.gatewayToken(context)).selectProvider(body);
                String newVersion = MoaProviderCatalog.profileVersion(response);
                if (!MoaProviderCatalog.confirmsNewVersion(oldVersion, response)) {
                    throw new IllegalStateException("gateway did not confirm a new profile version");
                }
                mainHandler.post(() -> {
                    if (request != generation) return;
                    status.setText("Selected " + choice.label + " · profile version " + newVersion);
                    status.setTextColor(MoaColors.OK);
                    load();
                });
            } catch (Exception error) {
                mainHandler.post(() -> showError(request, readableError(error)));
            }
        }, "moa-provider-selection").start();
    }

    private void setBusy(String message) {
        status.setText(message);
        status.setTextColor(MoaColors.GOLD);
        refresh.setEnabled(false);
        refresh.setAlpha(0.6f);
    }

    private void showError(int request, String message) {
        if (request != generation) return;
        status.setText(message);
        status.setTextColor(MoaColors.WARN);
        refresh.setEnabled(true);
        refresh.setAlpha(1f);
    }

    private String androidDeviceId() {
        String raw = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        String safe = raw == null ? "" : raw.replaceAll("[^a-zA-Z0-9_-]", "");
        return "android_" + (safe.isEmpty() ? "unknown" : safe);
    }

    private static String readableError(Exception error) {
        String value = error == null ? "Provider choices unavailable" : String.valueOf(error.getMessage()).trim();
        if (value.startsWith("HTTP 401") || value.startsWith("HTTP 403")) {
            return "Gateway authentication is required to change providers.";
        }
        if (value.length() > 180) value = value.substring(0, 180);
        return value.isEmpty() ? "Provider choices unavailable" : value;
    }

    private TextView text(String value, int color, int size, boolean bold) {
        return MoaTextViews.text(context, value, color, size, bold);
    }

    private Button button(String label) {
        Button button = new Button(context);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextColor(MoaColors.PAPER);
        button.setTextSize(14);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(MoaDrawables.rounded(
                0x14FFFFFF, dp(12), MoaColors.RAISED_BORDER, dp(1)));
        button.setMinHeight(dp(48));
        return button;
    }

    private static LinearLayout card(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(context, 18), dp(context, 18), dp(context, 18), dp(context, 18));
        card.setBackground(MoaDrawables.rounded(
                MoaColors.RAISED, dp(context, 20), MoaColors.RAISED_BORDER, dp(context, 1)));
        card.setElevation(dp(context, 6));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(context, 14);
        card.setLayoutParams(params);
        return card;
    }

    private int dp(int value) {
        return dp(context, value);
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}

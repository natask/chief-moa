package ag.companion;

import android.content.Context;
import android.graphics.Typeface;
import android.os.Handler;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;

/** Named work requests with honest device-only create/read authority. */
final class MoaDevelopmentRequestsView {
    private final Context context;
    private final Handler handler;
    private final String gateway;
    private final MoaDeviceCredentialStore.EnrollmentCredential enrollment;
    private final String deviceId;
    private LinearLayout items;
    private TextView status;
    private EditText nameInput;
    private EditText requestInput;
    private Button createButton;
    private int generation;

    MoaDevelopmentRequestsView(Context context, Handler handler, String gateway,
            MoaDeviceCredentialStore.EnrollmentCredential enrollment, String deviceId) {
        this.context = context;
        this.handler = handler;
        this.gateway = gateway;
        this.enrollment = enrollment;
        this.deviceId = deviceId;
    }

    View createView() {
        LinearLayout root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.addView(intro());
        root.addView(composer());
        TextView heading = text("Your requests", MoaColors.PAPER, 20, true);
        heading.setPadding(0, dp(22), 0, dp(4));
        root.addView(heading);
        status = text(enrollment == null ? "Connect this phone in Settings to create and view work."
                : "Loading work…", MoaColors.MUTED, 14, false);
        status.setPadding(0, dp(4), 0, dp(4));
        root.addView(status);
        items = new LinearLayout(context);
        items.setOrientation(LinearLayout.VERTICAL);
        root.addView(items);
        if (enrollment != null) refresh();
        return root;
    }

    void refresh() {
        if (status == null || enrollment == null) return;
        int run = ++generation;
        status.setText("Loading work…");
        new Thread(() -> {
            try {
                JSONObject response = client().list();
                handler.post(() -> { if (run == generation) render(response.optJSONArray("items")); });
            } catch (Exception error) {
                handler.post(() -> { if (run == generation) showError(error); });
            }
        }, "moa-development-request-list").start();
    }

    private View intro() {
        LinearLayout intro = new LinearLayout(context);
        intro.setOrientation(LinearLayout.VERTICAL);
        TextView title = text("Build with Ag", MoaColors.PAPER, 26, true);
        title.setPadding(0, dp(18), 0, dp(6));
        intro.addView(title);
        TextView detail = text("Name a change, explain what you want, and follow it separately from other work.",
                MoaColors.MUTED, 15, false);
        detail.setLineSpacing(dp(3), 1f);
        intro.addView(detail);
        return intro;
    }

    private View composer() {
        LinearLayout card = card();
        card.addView(text("New request", MoaColors.PAPER, 18, true));
        nameInput = input("Name this change", true);
        requestInput = input("What should change?", false);
        requestInput.setMinHeight(dp(112));
        requestInput.setGravity(android.view.Gravity.TOP);
        card.addView(nameInput);
        card.addView(requestInput);
        createButton = button("Create feature request");
        createButton.setEnabled(enrollment != null);
        createButton.setAlpha(enrollment == null ? 0.45f : 1f);
        createButton.setOnClickListener(view -> create());
        card.addView(createButton);
        return card;
    }

    private void create() {
        String name = nameInput.getText().toString().trim();
        String request = requestInput.getText().toString().trim();
        if (name.isEmpty() || request.isEmpty()) {
            status.setText("Add a name and describe the change.");
            return;
        }
        createButton.setEnabled(false);
        status.setText("Saving request…");
        String key = "android-" + UUID.randomUUID();
        new Thread(() -> {
            try {
                client().create(name, request, key);
                handler.post(() -> {
                    nameInput.setText(""); requestInput.setText("");
                    createButton.setEnabled(true); refresh();
                });
            } catch (Exception error) {
                handler.post(() -> { createButton.setEnabled(true); showError(error); });
            }
        }, "moa-development-request-create").start();
    }

    private void render(JSONArray rows) {
        items.removeAllViews();
        int count = rows == null ? 0 : rows.length();
        status.setText(count == 0 ? "No requests yet. Create one above." : count + (count == 1 ? " request" : " requests"));
        for (int index = 0; index < count; index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            LinearLayout card = card();
            card.addView(text(row.optString("display_name", "Untitled request"), MoaColors.PAPER, 17, true));
            TextView state = text(humanState(row.optString("status", "captured")), MoaColors.GOLD, 13, true);
            state.setPadding(0, dp(6), 0, dp(6));
            card.addView(state);
            TextView preview = text(row.optString("source_preview", ""), MoaColors.MUTED, 14, false);
            preview.setMaxLines(3);
            card.addView(preview);
            JSONObject progress = row.optJSONObject("progress");
            if (progress != null) {
                TextView current = text(progress.optInt("percent", 0) + "% · "
                        + progress.optString("summary", "In progress"), MoaColors.PAPER, 13, false);
                current.setPadding(0, dp(8), 0, 0);
                card.addView(current);
            }
            items.addView(card);
        }
    }

    private void showError(Exception error) {
        if (error instanceof MoaDevelopmentRequestsClient.HttpError
                && ((MoaDevelopmentRequestsClient.HttpError) error).status == 403) {
            status.setText("Reconnect this phone in Settings to enable work requests.");
        } else if (error instanceof MoaDevelopmentRequestsClient.HttpError
                && ((MoaDevelopmentRequestsClient.HttpError) error).status == 401) {
            status.setText("This phone is no longer connected. Reconnect it in Settings.");
        } else {
            status.setText("Could not load work. Check the connection and try again.");
        }
    }

    private MoaDevelopmentRequestsClient client() {
        return new MoaDevelopmentRequestsClient(gateway, enrollment.token, deviceId);
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(MoaDrawables.rounded(MoaColors.RAISED, dp(20), MoaColors.RAISED_BORDER, dp(1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(14);
        card.setLayoutParams(params);
        return card;
    }

    private EditText input(String hint, boolean singleLine) {
        EditText input = new EditText(context);
        input.setHint(hint); input.setHintTextColor(0x72EEF8E8); input.setTextColor(MoaColors.PAPER);
        input.setTextSize(15); input.setSingleLine(singleLine);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (singleLine
                ? InputType.TYPE_TEXT_FLAG_CAP_SENTENCES : InputType.TYPE_TEXT_FLAG_MULTI_LINE));
        input.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(14), MoaColors.RAISED_BORDER, dp(1)));
        input.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(10); input.setLayoutParams(params);
        return input;
    }

    private Button button(String value) {
        Button button = new Button(context);
        button.setAllCaps(false); button.setText(value); button.setTextColor(MoaColors.INK);
        button.setTextSize(16); button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setBackground(MoaDrawables.horizontalGradient(MoaColors.GOLD, 0xFFFFF1A6, dp(16)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12); button.setLayoutParams(params); button.setMinHeight(dp(52));
        return button;
    }

    private TextView text(String value, int color, int size, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value); view.setTextColor(color); view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private static String humanState(String value) {
        String state = value == null ? "Captured" : value.replace('_', ' ').trim();
        return state.isEmpty() ? "Captured" : Character.toUpperCase(state.charAt(0)) + state.substring(1);
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}

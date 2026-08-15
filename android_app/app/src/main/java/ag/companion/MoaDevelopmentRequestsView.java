package ag.companion;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;

/** Named work presented as a calm portfolio; creation is disclosed only when requested. */
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
    private Dialog composerDialog;
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
        root.addView(introStage());

        LinearLayout titleRow = new LinearLayout(context);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        titleParams.topMargin = dp(24);
        titleRow.setLayoutParams(titleParams);
        titleRow.addView(text("Your work", MoaColors.PAPER, 20, true),
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView refresh = text("Refresh", MoaColors.GOLD, 13, true);
        refresh.setGravity(Gravity.CENTER);
        refresh.setMinHeight(dp(48));
        refresh.setPadding(dp(12), dp(8), 0, dp(8));
        refresh.setClickable(true);
        refresh.setFocusable(true);
        refresh.setOnClickListener(view -> refresh());
        titleRow.addView(refresh);
        root.addView(titleRow);

        status = text(enrollment == null ? "Connect this phone in Settings to create and view work."
                : "Loading work…", MoaColors.MUTED, 14, false);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setPadding(0, dp(5), 0, dp(3));
        root.addView(status);
        if (enrollment == null) {
            TextView connect = text("Open Settings to connect  →", MoaColors.GOLD, 14, true);
            connect.setGravity(Gravity.CENTER_VERTICAL);
            connect.setMinHeight(dp(48));
            connect.setPadding(0, dp(8), 0, dp(8));
            connect.setClickable(true);
            connect.setFocusable(true);
            connect.setContentDescription("Open Settings to connect this phone");
            connect.setOnClickListener(view -> {
                View settings = ((android.app.Activity) context).findViewById(R.id.moa_settings_nav_target);
                if (settings != null) settings.performClick();
            });
            root.addView(connect);
        }
        items = new LinearLayout(context);
        items.setOrientation(LinearLayout.VERTICAL);
        root.addView(items);
        render(null);
        if (enrollment != null) refresh();
        return root;
    }

    void refresh() {
        if (status == null || enrollment == null) return;
        int run = ++generation;
        announce("Loading work…");
        new Thread(() -> {
            try {
                JSONObject response = client().list();
                handler.post(() -> { if (run == generation) render(response.optJSONArray("items")); });
            } catch (Exception error) {
                handler.post(() -> { if (run == generation) showError(error); });
            }
        }, "moa-development-request-list").start();
    }

    private View introStage() {
        LinearLayout stage = new LinearLayout(context);
        stage.setOrientation(LinearLayout.VERTICAL);
        stage.setPadding(dp(20), dp(22), dp(20), dp(20));
        stage.setBackground(MoaDrawables.diagonalGradient(
                0xFF171B20, 0xFF151519, 0xFF111114, dp(26), MoaColors.PANEL_BORDER, dp(1)));
        stage.setElevation(dp(7));

        TextView eyebrow = text("CHIEF MOA · BUILD QUEUE", MoaColors.GOLD, 10, true);
        eyebrow.setLetterSpacing(0.16f);
        stage.addView(eyebrow);
        TextView title = text("Turn an idea into a release.", MoaColors.PAPER, 25, true);
        title.setPadding(0, dp(10), 0, dp(6));
        stage.addView(title);
        TextView detail = text("Describe the outcome. Ag keeps each request separate, testable, and safe to promote.",
                MoaColors.MUTED, 14, false);
        detail.setLineSpacing(dp(3), 1f);
        stage.addView(detail);

        Button newRequest = quietButton("＋  New request");
        newRequest.setEnabled(enrollment != null);
        newRequest.setAlpha(enrollment == null ? 0.48f : 1f);
        newRequest.setOnClickListener(view -> showComposer());
        stage.addView(newRequest);
        return stage;
    }

    private void showComposer() {
        composerDialog = new Dialog(context);
        LinearLayout sheet = new LinearLayout(context);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(22), dp(14), dp(22), dp(24));
        sheet.setBackground(MoaDrawables.roundedGradient(
                MoaColors.RAISED_2, MoaColors.PANEL_BG, dp(28), MoaColors.PANEL_BORDER, dp(1)));

        TextView handle = new TextView(context);
        handle.setBackground(MoaDrawables.rounded(0x55FFFFFF, dp(99), 0, 0));
        LinearLayout.LayoutParams handleParams = new LinearLayout.LayoutParams(dp(36), dp(4));
        handleParams.gravity = Gravity.CENTER_HORIZONTAL;
        handleParams.bottomMargin = dp(18);
        sheet.addView(handle, handleParams);
        sheet.addView(text("New request", MoaColors.PAPER, 23, true));
        TextView detail = text("Give this piece of work a clear name and outcome.", MoaColors.MUTED, 14, false);
        detail.setPadding(0, dp(5), 0, dp(8));
        sheet.addView(detail);

        sheet.addView(fieldLabel("Name"));
        nameInput = input("Example: Refine mobile voice", true);
        nameInput.setImeOptions(EditorInfo.IME_ACTION_NEXT);
        nameInput.setNextFocusDownId(View.generateViewId());
        sheet.addView(nameInput);
        sheet.addView(fieldLabel("What should change?"));
        requestInput = input("Describe the result you want Ag to deliver…", false);
        requestInput.setId(nameInput.getNextFocusDownId());
        requestInput.setMinHeight(dp(116));
        requestInput.setGravity(Gravity.TOP);
        requestInput.setImeOptions(EditorInfo.IME_ACTION_DONE);
        sheet.addView(requestInput);

        createButton = quietButton("Create request  →");
        createButton.setOnClickListener(view -> create());
        sheet.addView(createButton);
        TextView cancel = text("Cancel", MoaColors.MUTED, 14, true);
        cancel.setGravity(Gravity.CENTER);
        cancel.setMinHeight(dp(48));
        cancel.setPadding(dp(12), dp(8), dp(12), dp(8));
        cancel.setClickable(true);
        cancel.setFocusable(true);
        cancel.setOnClickListener(view -> composerDialog.dismiss());
        sheet.addView(cancel);

        composerDialog.setContentView(sheet);
        Window window = composerDialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.setDimAmount(0.7f);
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            window.setGravity(Gravity.BOTTOM);
        }
        composerDialog.setOnShowListener(ignored -> {
            Window shown = composerDialog.getWindow();
            if (shown != null) shown.setLayout(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            nameInput.requestFocus();
        });
        composerDialog.show();
    }

    private void create() {
        String name = nameInput.getText().toString().trim();
        String request = requestInput.getText().toString().trim();
        if (name.isEmpty()) {
            nameInput.setError("Name this request");
            nameInput.requestFocus();
            return;
        }
        if (request.isEmpty()) {
            requestInput.setError("Describe the outcome you want");
            requestInput.requestFocus();
            return;
        }
        createButton.setEnabled(false);
        announce("Saving request…");
        String key = "android-" + UUID.randomUUID();
        new Thread(() -> {
            try {
                client().create(name, request, key);
                handler.post(() -> {
                    if (composerDialog != null) composerDialog.dismiss();
                    createButton.setEnabled(true);
                    refresh();
                });
            } catch (Exception error) {
                handler.post(() -> { createButton.setEnabled(true); showError(error); });
            }
        }, "moa-development-request-create").start();
    }

    private void render(JSONArray rows) {
        if (items == null) return;
        items.removeAllViews();
        int count = rows == null ? 0 : rows.length();
        if (status != null) announce(count == 0 ? "No requests yet. Your next idea can start here."
                : count + (count == 1 ? " active request" : " active requests"));
        if (count == 0) {
            LinearLayout empty = card();
            empty.addView(text("Nothing in flight", MoaColors.PAPER, 16, true));
            TextView hint = text("New work will appear here with its stage and latest progress.",
                    MoaColors.MUTED, 13, false);
            hint.setPadding(0, dp(5), 0, 0);
            empty.addView(hint);
            items.addView(empty);
            return;
        }
        for (int index = 0; index < count; index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            LinearLayout card = card();
            LinearLayout top = new LinearLayout(context);
            top.setGravity(Gravity.CENTER_VERTICAL);
            top.addView(text(row.optString("display_name", "Untitled request"), MoaColors.PAPER, 17, true),
                    new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView state = text(humanState(row.optString("status", "captured")), MoaColors.GOLD, 11, true);
            state.setBackground(MoaDrawables.rounded(MoaColors.GOLD_WASH, dp(99), MoaColors.GOLD_BORDER, dp(1)));
            state.setPadding(dp(10), dp(5), dp(10), dp(5));
            top.addView(state);
            card.addView(top);
            TextView preview = text(row.optString("source_preview", ""), MoaColors.MUTED, 14, false);
            preview.setPadding(0, dp(10), 0, 0);
            preview.setMaxLines(3);
            card.addView(preview);
            JSONObject progress = row.optJSONObject("progress");
            if (progress != null) {
                TextView current = text(progress.optInt("percent", 0) + "%  ·  "
                        + progress.optString("summary", "In progress"), MoaColors.PAPER, 13, false);
                current.setPadding(0, dp(10), 0, 0);
                card.addView(current);
            }
            items.addView(card);
        }
    }

    private void showError(Exception error) {
        if (error instanceof MoaDevelopmentRequestsClient.HttpError
                && ((MoaDevelopmentRequestsClient.HttpError) error).status == 403) {
            announce("Reconnect this phone in Settings to enable work requests.");
        } else if (error instanceof MoaDevelopmentRequestsClient.HttpError
                && ((MoaDevelopmentRequestsClient.HttpError) error).status == 401) {
            announce("This phone is no longer connected. Reconnect it in Settings.");
        } else {
            announce("Could not load work. Check the connection and try again.");
        }
    }

    private void announce(String value) {
        if (status == null) return;
        status.setText(value);
        status.announceForAccessibility(value);
    }

    private MoaDevelopmentRequestsClient client() {
        return new MoaDevelopmentRequestsClient(gateway, enrollment.token, deviceId);
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(17), dp(16), dp(17), dp(16));
        card.setBackground(MoaDrawables.roundedGradient(
                MoaColors.RAISED_2, MoaColors.RAISED, dp(20), MoaColors.RAISED_BORDER, dp(1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12);
        card.setLayoutParams(params);
        return card;
    }

    private TextView fieldLabel(String value) {
        TextView label = text(value, MoaColors.PAPER, 13, true);
        label.setPadding(0, dp(12), 0, dp(6));
        return label;
    }

    private EditText input(String hint, boolean singleLine) {
        EditText input = new EditText(context);
        input.setHint(hint);
        input.setHintTextColor(MoaColors.MUTED_DARK);
        input.setTextColor(MoaColors.PAPER);
        input.setTextSize(15);
        input.setSingleLine(singleLine);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (singleLine
                ? InputType.TYPE_TEXT_FLAG_CAP_SENTENCES : InputType.TYPE_TEXT_FLAG_MULTI_LINE));
        input.setBackground(MoaDrawables.rounded(MoaColors.COMPOSER_BG, dp(14), MoaColors.COMPOSER_BORDER, dp(1)));
        input.setPadding(dp(14), dp(12), dp(14), dp(12));
        return input;
    }

    private Button quietButton(String value) {
        Button button = new Button(context);
        button.setAllCaps(false);
        button.setText(value);
        button.setTextColor(MoaColors.PAPER);
        button.setTextSize(15);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setBackground(MoaDrawables.rounded(MoaColors.GOLD_WASH, dp(15), MoaColors.GOLD_BORDER, dp(1)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(16);
        button.setLayoutParams(params);
        button.setMinHeight(dp(50));
        return button;
    }

    private TextView text(String value, int color, int size, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
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

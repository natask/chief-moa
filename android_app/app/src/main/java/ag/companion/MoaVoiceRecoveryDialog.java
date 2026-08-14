package ag.companion;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.function.BiConsumer;
import java.util.function.Consumer;

/** Focusable recovery surface for a transcript that outlived voice transport. */
final class MoaVoiceRecoveryDialog {
    static final String ACTION_RECONNECT_DEVICE = "ag.companion.action.RECONNECT_DEVICE";
    static final String ACTION_OPEN_RELEASE_RESCUE = "ag.companion.action.OPEN_RELEASE_RESCUE";
    static AlertDialog show(Context context, int windowType,
            MoaVoiceFailureDraft.Snapshot draft,
            BiConsumer<String, String> sendAsText, Consumer<String> tryVoiceAgain) {
        LinearLayout content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        int spacing = dp(context, 12);
        content.setPadding(spacing * 2, spacing, spacing * 2, spacing);

        TextView explanation = new TextView(context);
        explanation.setText("Voice stopped before the turn finished. Your transcript is still here and editable.");
        explanation.setTextColor(Color.DKGRAY);
        explanation.setTextSize(14);
        content.addView(explanation);

        EditText editor = new EditText(context);
        editor.setText(draft.text);
        editor.setSelection(editor.getText().length());
        editor.setMinLines(2);
        editor.setMaxLines(6);
        editor.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        LinearLayout.LayoutParams editorParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        editorParams.topMargin = spacing;
        editorParams.bottomMargin = spacing;
        content.addView(editor, editorParams);

        AlertDialog dialog = new AlertDialog.Builder(context)
                .setTitle("Recover voice draft")
                .setView(content)
                .setNegativeButton("Keep draft", null)
                .create();

        Button send = action(context, MoaVoiceFailureDraft.SEND_AS_TEXT);
        Button retry = action(context, MoaVoiceFailureDraft.TRY_VOICE_AGAIN);
        Button reconnect = action(context, MoaVoiceFailureDraft.RECONNECT_DEVICE);
        Button rescue = action(context, MoaVoiceFailureDraft.OPEN_RELEASE_RESCUE);
        send.setEnabled(!draft.text.isEmpty());
        reconnect.setEnabled(draft.authenticationFailure);
        reconnect.setAlpha(draft.authenticationFailure ? 1f : 0.45f);
        content.addView(send);
        content.addView(retry);
        content.addView(reconnect);
        content.addView(rescue);

        send.setOnClickListener(view -> {
            String edited = editor.getText().toString().trim();
            if (!edited.isEmpty()) {
                dialog.dismiss();
                sendAsText.accept(edited, draft.requestId);
            }
        });
        retry.setOnClickListener(view -> {
            dialog.dismiss();
            tryVoiceAgain.accept(draft.requestId);
        });
        reconnect.setOnClickListener(view -> {
            dialog.dismiss();
            openApp(context, ACTION_RECONNECT_DEVICE,
                    "Reconnect this device in Ag settings.");
        });
        rescue.setOnClickListener(view -> {
            dialog.dismiss();
            openApp(context, ACTION_OPEN_RELEASE_RESCUE,
                    "Release rescue is not available in this build yet.");
        });

        Window window = dialog.getWindow();
        if (window != null) window.setType(windowType);
        dialog.show();
        editor.requestFocus();
        return dialog;
    }

    private static Button action(Context context, String label) {
        Button button = new Button(context);
        button.setText(label);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER_VERTICAL);
        button.setContentDescription(label);
        return button;
    }

    private static void openApp(Context context, String action, String notice) {
        Intent intent = new Intent(context, MainActivity.class).setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(intent);
            android.widget.Toast.makeText(context, notice, android.widget.Toast.LENGTH_LONG).show();
        } catch (RuntimeException error) {
            android.util.Log.w("MoaVoiceRecovery", "Could not open recovery surface", error);
        }
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}

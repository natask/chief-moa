package ag.companion;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.inputmethodservice.InputMethodService;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/** Minimal voice-first IME. Gateway output stays a candidate until Insert. */
public final class AgVoiceInputMethodService extends InputMethodService {
    private static final int MAX_CANDIDATE_CHARS = 16_384;

    private TextView statusView;
    private TextView candidateView;
    private Button microphoneButton;
    private Button insertButton;
    private MoaStreamingVoiceSessionController voice;
    private MoaImeEditorPolicy.EditorBinding captureBinding;
    private long editorGeneration;
    private EditorInfo currentEditor;
    private String candidate = "";

    @Override
    public View onCreateInputView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(10), dp(8), dp(10), dp(8));
        root.setBackgroundColor(MoaColors.SURFACE_0);

        statusView = label("Tap Speak to dictate", 13f, MoaColors.MUTED);
        root.addView(statusView);
        candidateView = label("", 18f, MoaColors.PAPER);
        candidateView.setTypeface(Typeface.DEFAULT, Typeface.NORMAL);
        candidateView.setMinHeight(dp(48));
        candidateView.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(candidateView, fullWidth());

        LinearLayout actions = row();
        microphoneButton = button("Speak", view -> toggleCapture());
        insertButton = button("Insert", view -> insertCandidate());
        insertButton.setEnabled(false);
        actions.addView(microphoneButton, weighted());
        actions.addView(insertButton, weighted());
        actions.addView(button("Cancel", view -> cancelCaptureAndCandidate()), weighted());
        root.addView(actions, fullWidth());

        LinearLayout keys = row();
        keys.addView(button("⌫", view -> deleteOne()), weighted());
        keys.addView(button("Space", view -> commitText(" ")), weighted());
        keys.addView(button(".", view -> commitText(".")), weighted());
        keys.addView(button("Enter", view -> performEnter()), weighted());
        keys.addView(button("⌨", view -> switchKeyboard()), weighted());
        root.addView(keys, fullWidth());
        refreshEditorState();
        return root;
    }

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        super.onStartInput(attribute, restarting);
        editorGeneration++;
        currentEditor = attribute;
        cancelActiveVoice();
        clearCandidate();
        refreshEditorState();
    }

    @Override
    public void onFinishInput() {
        editorGeneration++;
        currentEditor = null;
        cancelActiveVoice();
        clearCandidate();
        super.onFinishInput();
    }

    @Override
    public void onDestroy() {
        destroyVoice();
        super.onDestroy();
    }

    private void toggleCapture() {
        if (MoaImeEditorPolicy.isSensitive(currentEditor)) {
            setStatus("Voice typing is unavailable in sensitive fields.");
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            setStatus("Enable microphone access in Ag before dictating.");
            return;
        }
        if (voice != null && voice.isActive()) {
            microphoneButton.setEnabled(false);
            setStatus("Transcribing…");
            voice.commitTurn();
            return;
        }
        startCapture();
    }

    private void startCapture() {
        destroyVoice();
        clearCandidate();
        captureBinding = MoaImeEditorPolicy.bind(currentEditor, editorGeneration);
        if (captureBinding == null) {
            setStatus("Voice typing is unavailable in this field.");
            return;
        }
        String sessionId = MoaPrefs.conversationId(this);
        String branchId = MoaPrefs.conversationBranchId(this, sessionId);
        voice = new MoaStreamingVoiceSessionController(
                MoaPrefs.gatewayUrl(this),
                MoaPrefs.gatewayToken(this),
                false,
                sessionId,
                branchId,
                false,
                new VoiceCallback());
        voice.setTranscriptionOnly(true);
        voice.setSourceSurface("android-ime");
        voice.startSession();
        microphoneButton.setText("Finish");
        microphoneButton.setEnabled(true);
        setStatus("Listening — tap Finish when done");
    }

    private void insertCandidate() {
        if (candidate.isEmpty() || captureBinding == null
                || !captureBinding.matches(currentEditor, editorGeneration)) {
            clearCandidate();
            setStatus("The destination changed. Dictate again in this field.");
            return;
        }
        InputConnection connection = getCurrentInputConnection();
        if (connection == null || !connection.commitText(candidate, 1)) {
            setStatus("Could not insert. The transcript is still available above.");
            return;
        }
        clearCandidate();
        setStatus("Inserted");
    }

    private void cancelCaptureAndCandidate() {
        cancelActiveVoice();
        clearCandidate();
        setStatus(MoaImeEditorPolicy.isSensitive(currentEditor)
                ? "Voice typing is unavailable in sensitive fields."
                : "Canceled");
    }

    private void cancelActiveVoice() {
        if (voice != null && voice.isActive()) voice.cancel();
        destroyVoice();
    }

    private void destroyVoice() {
        releaseVoiceController();
        captureBinding = null;
    }

    private void releaseVoiceController() {
        if (voice != null) voice.destroy();
        voice = null;
        if (microphoneButton != null) {
            microphoneButton.setText("Speak");
            microphoneButton.setEnabled(!MoaImeEditorPolicy.isSensitive(currentEditor));
        }
    }

    private void acceptTranscript(String text, boolean isFinal) {
        if (captureBinding == null || !captureBinding.matches(currentEditor, editorGeneration)) return;
        String value = bounded(text);
        if (value.isEmpty()) return;
        candidateView.setText(value);
        if (isFinal) candidate = value;
        insertButton.setEnabled(isFinal);
    }

    private void clearCandidate() {
        candidate = "";
        captureBinding = null;
        if (candidateView != null) candidateView.setText("");
        if (insertButton != null) insertButton.setEnabled(false);
    }

    private void refreshEditorState() {
        boolean sensitive = MoaImeEditorPolicy.isSensitive(currentEditor);
        if (microphoneButton != null) microphoneButton.setEnabled(!sensitive);
        if (sensitive) {
            clearCandidate();
            setStatus("Voice typing is unavailable in sensitive fields.");
        }
    }

    private void deleteOne() {
        InputConnection connection = getCurrentInputConnection();
        if (connection != null) connection.deleteSurroundingText(1, 0);
    }

    private void commitText(String text) {
        InputConnection connection = getCurrentInputConnection();
        if (connection != null) connection.commitText(text, 1);
    }

    private void performEnter() {
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) return;
        int action = currentEditor == null
                ? EditorInfo.IME_ACTION_NONE
                : currentEditor.imeOptions & EditorInfo.IME_MASK_ACTION;
        if (action == EditorInfo.IME_ACTION_NONE || action == EditorInfo.IME_ACTION_UNSPECIFIED) {
            connection.commitText("\n", 1);
        } else {
            connection.performEditorAction(action);
        }
    }

    private void switchKeyboard() {
        InputMethodManager manager = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (manager != null && getWindow() != null && getWindow().getWindow() != null) {
            manager.switchToNextInputMethod(getWindow().getWindow().getAttributes().token, false);
        }
    }

    private void setStatus(String text) {
        if (statusView != null) statusView.setText(text);
    }

    private TextView label(String text, float size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private Button button(String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(text);
        button.setOnClickListener(listener);
        return button;
    }

    private LinearLayout row() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        return row;
    }

    private LinearLayout.LayoutParams weighted() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    private LinearLayout.LayoutParams fullWidth() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String bounded(String text) {
        String value = text == null ? "" : text.trim();
        return value.length() <= MAX_CANDIDATE_CHARS
                ? value : value.substring(0, MAX_CANDIDATE_CHARS);
    }

    private final class VoiceCallback implements MoaStreamingVoiceSessionController.Callback {
        @Override public void onSessionStarted(String sessionId, String turnId) { }
        @Override public void onSessionReady(String sessionId) { setStatus("Listening — tap Finish when done"); }
        @Override public void onRecordingStarted() { }
        @Override public void onAudioCaptured() { }
        @Override public void onRecordingStopped() { setStatus("Transcribing…"); }
        @Override public void onTranscriptPartial(String turnId, String text, long transcriptSequence) {
            acceptTranscript(text, false);
        }
        @Override public void onTranscriptFinal(String turnId, String text, long transcriptSequence) {
            acceptTranscript(text, true);
        }
        @Override public void onAssistantText(String turnId, String text) { }
        @Override public void onAssistantAudioStarted(String turnId) { }
        @Override public void onAssistantAudioChunk(String turnId) { }
        @Override public void onAssistantPlaybackProgress(String turnId, String text, int spokenChars) { }
        @Override public void onAssistantAudioDone(String turnId) { }
        @Override public void onTurnProgress(String turnId) { }
        @Override public void onTurnDone(String turnId, String status, boolean transcriptionOnly,
                boolean ttsSpoke, String replyLanguage, JSONObject terminalEvent) {
            if ("completed".equals(status) && transcriptionOnly && !candidate.isEmpty()) {
                setStatus("Review, then tap Insert");
            } else {
                clearCandidate();
                setStatus("Dictation failed. Tap Speak to retry.");
            }
            releaseVoiceController();
        }
        @Override public void onTtsRetryDone(String turnId, String retryId, String status,
                int fromTextChar, String error) { }
        @Override public void onSessionClosed() { }
        @Override public void onError(String message, Throwable error) {
            clearCandidate();
            destroyVoice();
            setStatus(message == null || message.trim().isEmpty()
                    ? "Dictation failed. Tap Speak to retry." : message);
        }
    }
}

package ai.moa.assistant;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.inputmethodservice.InputMethodService;
import android.os.Bundle;
import android.os.Build;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Opt-in literal dictation IME. Android SpeechRecognizer supplies a transcript candidate;
 * this service never receives durable audio and never calls a model, tool, submit action, or TTS.
 */
public final class MoaInputMethodService extends InputMethodService {
    private final MoaEditorSessionBinding binding = new MoaEditorSessionBinding();
    private MoaEditorSessionBinding.SessionToken editorSession;
    private MoaEditorSessionBinding.SessionToken recognitionSession;
    private SpeechRecognizer speechRecognizer;
    private boolean listening;
    private TextView statusView;
    private TextView candidateView;
    private Button dictateButton;
    private Button insertButton;
    private Button cancelButton;

    @Override
    public View onCreateInputView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(12), dp(16), dp(12));
        root.setBackgroundColor(MoaColors.SURFACE_0);

        statusView = text("Dictate · Android speech service · no durable audio", MoaColors.MUTED, 13);
        root.addView(statusView);

        candidateView = text("", MoaColors.PAPER, 17);
        candidateView.setPadding(0, dp(12), 0, dp(8));
        root.addView(candidateView);

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(actions);

        dictateButton = button("Hold to Dictate");
        dictateButton.setContentDescription("Hold to dictate literal text, then release to finish");
        dictateButton.setOnTouchListener((view, event) -> handleDictateTouch(event));
        actions.addView(dictateButton, weightedButtonParams());

        insertButton = button("Insert");
        insertButton.setOnClickListener(view -> commitCandidate());
        actions.addView(insertButton, weightedButtonParams());

        cancelButton = button("Cancel");
        cancelButton.setOnClickListener(view -> {
            binding.clearCandidate();
            renderState("Candidate cleared");
        });
        actions.addView(cancelButton, weightedButtonParams());

        Button nextKeyboard = button("Next keyboard");
        nextKeyboard.setOnClickListener(view -> switchKeyboard());
        root.addView(nextKeyboard, fullButtonParams());

        renderState(null);
        return root;
    }

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        super.onStartInput(attribute, restarting);
        destroySpeechRecognizer();
        editorSession = binding.beginEditor(MoaEditorSensitivityPolicy.EditorIdentity.from(attribute));
        renderState(null);
    }

    @Override
    public void onFinishInput() {
        destroySpeechRecognizer();
        binding.finishEditor();
        editorSession = null;
        renderState(null);
        super.onFinishInput();
    }

    @Override
    public boolean onEvaluateFullscreenMode() {
        return false;
    }

    @Override
    public void onDestroy() {
        destroySpeechRecognizer();
        super.onDestroy();
    }

    private boolean handleDictateTouch(MotionEvent event) {
        if (event == null) {
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            startLiteralRecognition();
        } else if (event.getActionMasked() == MotionEvent.ACTION_UP) {
            stopLiteralRecognition();
        } else if (event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            cancelLiteralRecognition("Dictation interrupted · no text inserted");
        }
        return true;
    }

    private void startLiteralRecognition() {
        MoaEditorSensitivityPolicy.EditorIdentity observed =
                MoaEditorSensitivityPolicy.EditorIdentity.from(getCurrentInputEditorInfo());
        MoaEditorSessionBinding.Rejection rejection = binding.validateEditor(editorSession, observed);
        if (rejection != MoaEditorSessionBinding.Rejection.NONE) {
            binding.clearCandidate();
            renderState(rejectionMessage(rejection));
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            renderState("Microphone permission is off · enable it in the A.G. app");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            renderState("Android speech recognition is unavailable");
            return;
        }

        destroySpeechRecognizer();
        binding.clearCandidate();
        recognitionSession = editorSession;
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        speechRecognizer.setRecognitionListener(new LiteralRecognitionListener());
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        String language = MoaPrefs.inputLanguageTag(this);
        if (language != null && !language.trim().isEmpty()) {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language.trim());
        }
        listening = true;
        renderState("Listening · release to finish literal text");
        try {
            speechRecognizer.startListening(intent);
        } catch (RuntimeException error) {
            destroySpeechRecognizer();
            renderState("Dictation could not start · no text inserted");
        }
    }

    private void stopLiteralRecognition() {
        if (!listening || speechRecognizer == null) {
            return;
        }
        listening = false;
        speechRecognizer.stopListening();
        renderState("Finishing literal transcript…");
    }

    private void cancelLiteralRecognition(String status) {
        if (speechRecognizer != null) {
            speechRecognizer.cancel();
        }
        listening = false;
        recognitionSession = null;
        binding.clearCandidate();
        renderState(status);
    }

    private void destroySpeechRecognizer() {
        if (speechRecognizer != null) {
            speechRecognizer.cancel();
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
        listening = false;
        recognitionSession = null;
    }

    private void stageRecognition(Bundle results, boolean finalResult) {
        String literal = MoaLiteralTranscriptPolicy.firstLiteral(
                results == null ? null : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        );
        MoaEditorSensitivityPolicy.EditorIdentity observed =
                MoaEditorSensitivityPolicy.EditorIdentity.from(getCurrentInputEditorInfo());
        MoaEditorSessionBinding.Rejection rejection = binding.validateEditor(recognitionSession, observed);
        if (rejection != MoaEditorSessionBinding.Rejection.NONE) {
            cancelLiteralRecognition(rejectionMessage(rejection));
            return;
        }
        if (literal == null) {
            if (finalResult) {
                renderState("No speech recognized · no text inserted");
            }
            return;
        }
        rejection = binding.stageCandidate(recognitionSession, literal);
        if (finalResult) {
            listening = false;
            renderState(rejection == MoaEditorSessionBinding.Rejection.NONE
                    ? "Literal candidate ready · review before Insert"
                    : rejectionMessage(rejection));
        } else {
            renderState(rejection == MoaEditorSessionBinding.Rejection.NONE
                    ? "Listening · partial literal candidate"
                    : rejectionMessage(rejection));
        }
    }

    private void commitCandidate() {
        MoaEditorSensitivityPolicy.EditorIdentity currentEditor =
                MoaEditorSensitivityPolicy.EditorIdentity.from(getCurrentInputEditorInfo());
        MoaEditorSessionBinding.CommitDecision decision =
                binding.authorizeCommit(editorSession, currentEditor);
        if (!decision.allowed) {
            renderState(rejectionMessage(decision.rejection));
            return;
        }
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) {
            renderState("Editor connection unavailable");
            return;
        }
        boolean committed = connection.commitText(decision.exactText, 1);
        if (committed) {
            binding.clearCandidate();
            renderState("Inserted exactly; nothing was submitted");
        } else {
            renderState("Editor refused insertion");
        }
    }

    private void switchKeyboard() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || !switchToNextInputMethod(false)) {
            InputMethodManager manager = getSystemService(InputMethodManager.class);
            if (manager != null) {
                manager.showInputMethodPicker();
            }
        }
    }

    private void renderState(String message) {
        if (statusView == null || candidateView == null) {
            return;
        }
        boolean sensitive = binding.isSensitive(editorSession);
        String candidate = binding.visibleCandidate(editorSession);
        if (sensitive) {
            statusView.setText("Unavailable in password, private, or unsupported fields");
            candidateView.setText("");
        } else {
            statusView.setText(message == null
                    ? "Dictate · Android speech service · no durable audio"
                    : message);
            candidateView.setText(candidate == null ? "No candidate staged" : candidate);
        }
        if (dictateButton != null) {
            dictateButton.setEnabled(!sensitive);
            dictateButton.setText(listening ? "Release to finish" : "Hold to Dictate");
        }
        if (insertButton != null) {
            insertButton.setEnabled(!sensitive && candidate != null);
        }
        if (cancelButton != null) {
            cancelButton.setEnabled(!sensitive && candidate != null);
        }
    }

    private String rejectionMessage(MoaEditorSessionBinding.Rejection rejection) {
        switch (rejection) {
            case SENSITIVE_EDITOR:
                return "Sensitive editor: insertion blocked";
            case EMPTY_CANDIDATE:
                return "Candidate is empty";
            case STALE_EDITOR:
                return "Editor changed: stage the candidate again";
            case NO_CANDIDATE:
                return "No candidate staged";
            case NO_ACTIVE_EDITOR:
                return "No active editor";
            default:
                return "Insertion unavailable";
        }
    }

    private final class LiteralRecognitionListener implements RecognitionListener {
        @Override
        public void onReadyForSpeech(Bundle params) {
            renderState("Listening · release to finish literal text");
        }

        @Override
        public void onBeginningOfSpeech() {
            renderState("Listening · speaking detected");
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
            // SpeechRecognizer audio is not a durable capture block. Do not retain it.
        }

        @Override
        public void onEndOfSpeech() {
            listening = false;
            renderState("Finishing literal transcript…");
        }

        @Override
        public void onError(int error) {
            listening = false;
            recognitionSession = null;
            binding.clearCandidate();
            renderState(error == SpeechRecognizer.ERROR_NO_MATCH
                    || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                    ? "No speech recognized · no text inserted"
                    : "Dictation failed · no text inserted");
        }

        @Override
        public void onResults(Bundle results) {
            stageRecognition(results, true);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            stageRecognition(partialResults, false);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    }

    private TextView text(String value, int color, int sp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(sp);
        return view;
    }

    private Button button(String value) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(value);
        button.setTextColor(MoaColors.PAPER);
        button.setBackground(MoaDrawables.rounded(0x14FFFFFF, dp(12), MoaColors.RAISED_BORDER, dp(1)));
        return button;
    }

    private LinearLayout.LayoutParams weightedButtonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(52), 1f);
        params.setMarginEnd(dp(6));
        return params;
    }

    private LinearLayout.LayoutParams fullButtonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(48)
        );
        params.topMargin = dp(8);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
